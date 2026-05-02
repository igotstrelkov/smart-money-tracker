// SQLite storage for deduplication.
// Tracks which trades we've already seen so we don't alert on them twice.
// Uses better-sqlite3 for synchronous, simple access.

import Database from "better-sqlite3";

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_trades (
      transaction_hash TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      observed_at INTEGER NOT NULL
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
