// SQLite storage for deduplication, market metadata caching, and alert logging.
// Tracks seen trades, caches Gamma API market lookups, and records every alert
// (BUY and SELL) sent. Uses better-sqlite3 for synchronous, simple access.

import Database from "better-sqlite3";
import type { MarketMeta, Alert } from "./types.js";

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_trades (
      transaction_hash TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      observed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS market_cache (
      condition_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      event_slug TEXT,
      cached_at INTEGER NOT NULL
    );

    DROP TABLE IF EXISTS shadow_positions;

    CREATE TABLE IF NOT EXISTS alerts (
      transaction_hash TEXT PRIMARY KEY,
      leader_wallet TEXT NOT NULL,
      leader_name TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      side TEXT NOT NULL,
      leader_fill_price REAL NOT NULL,
      market_title TEXT NOT NULL,
      market_slug TEXT NOT NULL,
      alert_timestamp INTEGER NOT NULL,
      hypothetical_price REAL,
      hypothetical_size_usd REAL,
      evaluation_status TEXT,
      evaluated_at INTEGER,
      evaluated_value_usd REAL,
      evaluated_pnl_usd REAL
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_dedup
      ON alerts(leader_wallet, condition_id, side, alert_timestamp);

    CREATE INDEX IF NOT EXISTS idx_alerts_position_replay
      ON alerts(leader_wallet, condition_id, outcome, alert_timestamp);
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

export function logAlert(db: Database.Database, alert: Alert): void {
  db.prepare(`
    INSERT OR IGNORE INTO alerts (
      transaction_hash, leader_wallet, leader_name, condition_id, token_id,
      outcome, side, leader_fill_price, market_title, market_slug, alert_timestamp,
      hypothetical_price, hypothetical_size_usd, evaluation_status,
      evaluated_at, evaluated_value_usd, evaluated_pnl_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    alert.transactionHash,
    alert.leaderWallet,
    alert.leaderName,
    alert.conditionId,
    alert.tokenId,
    alert.outcome,
    alert.side,
    alert.leaderFillPrice,
    alert.marketTitle,
    alert.marketSlug,
    alert.alertTimestamp,
    alert.hypotheticalPrice ?? null,
    alert.hypotheticalSizeUsd ?? null,
    alert.evaluationStatus ?? null,
    alert.evaluatedAt ?? null,
    alert.evaluatedValueUsd ?? null,
    alert.evaluatedPnlUsd ?? null
  );
}

function mapAlertRow(row: Record<string, unknown>): Alert {
  return {
    transactionHash: row.transaction_hash as string,
    leaderWallet: row.leader_wallet as string,
    leaderName: row.leader_name as string,
    conditionId: row.condition_id as string,
    tokenId: row.token_id as string,
    outcome: row.outcome as string,
    side: row.side as "BUY" | "SELL",
    leaderFillPrice: row.leader_fill_price as number,
    marketTitle: row.market_title as string,
    marketSlug: row.market_slug as string,
    alertTimestamp: row.alert_timestamp as number,
    hypotheticalPrice: (row.hypothetical_price as number | null) ?? undefined,
    hypotheticalSizeUsd: (row.hypothetical_size_usd as number | null) ?? undefined,
    evaluationStatus: (row.evaluation_status as Alert["evaluationStatus"]) ?? undefined,
    evaluatedAt: (row.evaluated_at as number | null) ?? undefined,
    evaluatedValueUsd: (row.evaluated_value_usd as number | null) ?? undefined,
    evaluatedPnlUsd: (row.evaluated_pnl_usd as number | null) ?? undefined,
  };
}

export function getOpenShadowedAlerts(db: Database.Database): Alert[] {
  const rows = db
    .prepare(
      "SELECT * FROM alerts WHERE side = 'BUY' AND evaluation_status = 'open' ORDER BY alert_timestamp"
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapAlertRow);
}

export function getAllAlerts(db: Database.Database): Alert[] {
  const rows = db
    .prepare("SELECT * FROM alerts ORDER BY alert_timestamp DESC")
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapAlertRow);
}

export function getShadowedBuyAlerts(db: Database.Database): Alert[] {
  const rows = db
    .prepare(
      "SELECT * FROM alerts WHERE side = 'BUY' AND evaluation_status IS NOT NULL ORDER BY alert_timestamp"
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapAlertRow);
}

export function findFirstBuyForGroup(
  db: Database.Database,
  leaderWallet: string,
  conditionId: string,
  outcome: string
): Alert | null {
  const row = db
    .prepare(
      `SELECT * FROM alerts
       WHERE leader_wallet = ? AND condition_id = ? AND outcome = ? AND side = 'BUY'
       ORDER BY alert_timestamp ASC LIMIT 1`
    )
    .get(leaderWallet, conditionId, outcome) as Record<string, unknown> | undefined;
  return row ? mapAlertRow(row) : null;
}

export function findFirstSellAfterBuy(
  db: Database.Database,
  leaderWallet: string,
  conditionId: string,
  outcome: string,
  buyTimestamp: number
): Alert | null {
  const row = db
    .prepare(
      `SELECT * FROM alerts
       WHERE leader_wallet = ? AND condition_id = ? AND outcome = ?
         AND side = 'SELL' AND alert_timestamp > ?
       ORDER BY alert_timestamp ASC LIMIT 1`
    )
    .get(leaderWallet, conditionId, outcome, buyTimestamp) as
    | Record<string, unknown>
    | undefined;
  return row ? mapAlertRow(row) : null;
}

export function findRecentAlertForLogicalTrade(
  db: Database.Database,
  leaderWallet: string,
  conditionId: string,
  side: "BUY" | "SELL",
  withinSeconds: number
): Alert | null {
  const cutoff = Date.now() - withinSeconds * 1000;
  const row = db
    .prepare(
      `SELECT * FROM alerts
       WHERE leader_wallet = ? AND condition_id = ? AND side = ?
         AND alert_timestamp >= ?
       ORDER BY alert_timestamp DESC LIMIT 1`
    )
    .get(leaderWallet, conditionId, side, cutoff) as
    | Record<string, unknown>
    | undefined;
  return row ? mapAlertRow(row) : null;
}

export function updateShadowEvaluation(
  db: Database.Database,
  transactionHash: string,
  valueUsd: number | null,
  pnlUsd: number | null,
  status: NonNullable<Alert["evaluationStatus"]>,
  evaluatedAt?: number
): void {
  db.prepare(`
    UPDATE alerts
    SET evaluated_value_usd = ?, evaluated_pnl_usd = ?, evaluation_status = ?, evaluated_at = ?
    WHERE transaction_hash = ?
  `).run(valueUsd, pnlUsd, status, evaluatedAt ?? Date.now(), transactionHash);
}
