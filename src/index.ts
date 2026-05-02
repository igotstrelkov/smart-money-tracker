// Entry point for the smart-money tracker.
// Stage 4: polls all wallets from slate.json, deduplicates via SQLite.

import { mkdirSync } from "node:fs";
import { loadSlate } from "./config.js";
import { fetchTrades } from "./api/data.js";
import { openDb, hasSeenTrade, markTradeSeen } from "./store.js";
import type { Trade } from "./types.js";
import type { SlateEntry } from "./config.js";

const POLL_INTERVAL_MS = 30_000;
const WALLET_DELAY_MS = 200;
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const DB_PATH = "data/tracker.db";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTrade(name: string, trade: Trade): string {
  const price = trade.price.toFixed(2);
  const size = trade.size.toFixed(0);
  const cost = (trade.price * trade.size).toFixed(2);
  const time = new Date(trade.timestamp * 1000).toISOString();
  return `[${time}] [${name}] ${trade.side} ${trade.outcome} on "${trade.title}" at $${price} × ${size} ($${cost})`;
}

function isStale(trade: Trade): boolean {
  const tradeMs = trade.timestamp * 1000;
  return Date.now() - tradeMs > STALE_THRESHOLD_MS;
}

async function pollWallet(
  db: ReturnType<typeof openDb>,
  entry: SlateEntry
): Promise<number> {
  const trades = await fetchTrades(entry.address, 5);
  let newCount = 0;

  for (const trade of trades) {
    if (isStale(trade)) continue;
    if (hasSeenTrade(db, trade.transactionHash)) continue;

    console.log(formatTrade(entry.name, trade));
    markTradeSeen(db, trade.transactionHash, entry.address);
    newCount++;
  }

  return newCount;
}

async function main() {
  const slate = loadSlate();

  mkdirSync("data", { recursive: true });
  const db = openDb(DB_PATH);

  const names = slate.map((e) => e.name).join(", ");
  console.log(`Watching ${slate.length} wallets: ${names}`);
  console.log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`DB: ${DB_PATH}`);

  while (true) {
    let totalNew = 0;

    for (let i = 0; i < slate.length; i++) {
      try {
        totalNew += await pollWallet(db, slate[i]);
      } catch (err) {
        console.error(`Fetch error for ${slate[i].name}:`, err);
      }

      if (i < slate.length - 1) {
        await sleep(WALLET_DELAY_MS);
      }
    }

    if (totalNew === 0) {
      console.log(`[${new Date().toISOString()}] No new trades.`);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

main();
