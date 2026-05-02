// SQLite storage for deduplication and market metadata caching.
// Tracks seen trades and caches Gamma API market lookups.
// Uses better-sqlite3 for synchronous, simple access.

import Database from "better-sqlite3";
import type { MarketMeta, ShadowPosition } from "./types.js";

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_trades (
      transaction_hash TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      observed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shadow_positions (
      transaction_hash TEXT PRIMARY KEY,
      leader_wallet TEXT NOT NULL,
      leader_name TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      side TEXT NOT NULL,
      leader_fill_price REAL NOT NULL,
      hypothetical_entry_price REAL NOT NULL,
      hypothetical_size_usd REAL NOT NULL,
      market_title TEXT NOT NULL,
      market_slug TEXT NOT NULL,
      alert_timestamp INTEGER NOT NULL,
      evaluation_status TEXT NOT NULL DEFAULT 'open',
      evaluated_at INTEGER,
      evaluated_value_usd REAL,
      evaluated_pnl_usd REAL
    );

    CREATE TABLE IF NOT EXISTS market_cache (
      condition_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      event_slug TEXT,
      cached_at INTEGER NOT NULL
    );
  `);

  return db;
}

export function hasSeenTrade(
  db: Database.Database,
  transactionHash: string
): boolean {
  const row = db
    .prepare("SELECT 1 FROM seen_trades WHERE transaction_hash = ?")
    .get(transactionHash);
  return row !== undefined;
}

export function markTradeSeen(
  db: Database.Database,
  transactionHash: string,
  walletAddress: string
): void {
  db.prepare(
    "INSERT OR IGNORE INTO seen_trades (transaction_hash, wallet_address, observed_at) VALUES (?, ?, ?)"
  ).run(transactionHash, walletAddress, Date.now());
}

export function getCachedMarket(
  db: Database.Database,
  conditionId: string
): MarketMeta | null {
  const row = db
    .prepare(
      "SELECT condition_id, title, slug, event_slug FROM market_cache WHERE condition_id = ?"
    )
    .get(conditionId) as
    | { condition_id: string; title: string; slug: string; event_slug: string | null }
    | undefined;

  if (!row) return null;

  return {
    conditionId: row.condition_id,
    title: row.title,
    slug: row.slug,
    eventSlug: row.event_slug,
  };
}

export function setCachedMarket(
  db: Database.Database,
  market: MarketMeta
): void {
  db.prepare(
    "INSERT OR REPLACE INTO market_cache (condition_id, title, slug, event_slug, cached_at) VALUES (?, ?, ?, ?, ?)"
  ).run(market.conditionId, market.title, market.slug, market.eventSlug, Date.now());
}

export function logShadowPosition(
  db: Database.Database,
  position: ShadowPosition
): void {
  db.prepare(`
    INSERT OR IGNORE INTO shadow_positions (
      transaction_hash, leader_wallet, leader_name, condition_id, token_id,
      outcome, side, leader_fill_price, hypothetical_entry_price,
      hypothetical_size_usd, market_title, market_slug, alert_timestamp,
      evaluation_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    position.transactionHash,
    position.leaderWallet,
    position.leaderName,
    position.conditionId,
    position.tokenId,
    position.outcome,
    position.side,
    position.leaderFillPrice,
    position.hypotheticalEntryPrice,
    position.hypotheticalSizeUsd,
    position.marketTitle,
    position.marketSlug,
    position.alertTimestamp,
    position.evaluationStatus
  );
}

export function getOpenShadowPositions(
  db: Database.Database
): ShadowPosition[] {
  const rows = db
    .prepare("SELECT * FROM shadow_positions WHERE evaluation_status = 'open'")
    .all() as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    transactionHash: row.transaction_hash as string,
    leaderWallet: row.leader_wallet as string,
    leaderName: row.leader_name as string,
    conditionId: row.condition_id as string,
    tokenId: row.token_id as string,
    outcome: row.outcome as string,
    side: row.side as string,
    leaderFillPrice: row.leader_fill_price as number,
    hypotheticalEntryPrice: row.hypothetical_entry_price as number,
    hypotheticalSizeUsd: row.hypothetical_size_usd as number,
    marketTitle: row.market_title as string,
    marketSlug: row.market_slug as string,
    alertTimestamp: row.alert_timestamp as number,
    evaluationStatus: row.evaluation_status as ShadowPosition["evaluationStatus"],
    evaluatedAt: row.evaluated_at as number | null,
    evaluatedValueUsd: row.evaluated_value_usd as number | null,
    evaluatedPnlUsd: row.evaluated_pnl_usd as number | null,
  }));
}

export function updateShadowEvaluation(
  db: Database.Database,
  transactionHash: string,
  valueUsd: number | null,
  pnlUsd: number | null,
  status: ShadowPosition["evaluationStatus"]
): void {
  db.prepare(`
    UPDATE shadow_positions
    SET evaluated_value_usd = ?, evaluated_pnl_usd = ?, evaluation_status = ?, evaluated_at = ?
    WHERE transaction_hash = ?
  `).run(valueUsd, pnlUsd, status, Date.now(), transactionHash);
}
