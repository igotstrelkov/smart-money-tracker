// SQLite storage for deduplication and market metadata caching.
// Tracks seen trades and caches Gamma API market lookups.
// Uses better-sqlite3 for synchronous, simple access.

import Database from "better-sqlite3";
import type { MarketMeta } from "./types.js";

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
