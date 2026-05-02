// Entry point for the smart-money tracker.
// Stage 3: polls one wallet, deduplicates via SQLite, skips stale trades.

import "dotenv/config";
import { mkdirSync } from "node:fs";
import { fetchTrades } from "./api/data.js";
import { openDb, hasSeenTrade, markTradeSeen } from "./store.js";
import type { Trade } from "./types.js";

const WALLET = "0x5bec79df9add70a3892041ab1a5516b60f53b215"; // guongAI
const POLL_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const DB_PATH = "data/tracker.db";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTrade(trade: Trade): string {
  const price = trade.price.toFixed(2);
  const size = trade.size.toFixed(0);
  const cost = (trade.price * trade.size).toFixed(2);
  const time = new Date(trade.timestamp * 1000).toISOString();
  return `[${time}] ${trade.side} ${trade.outcome} on "${trade.title}" at $${price} × ${size} ($${cost}) — tx:${trade.transactionHash.slice(0, 10)}…`;
}

function isStale(trade: Trade): boolean {
  const tradeMs = trade.timestamp * 1000; // API returns seconds
  return Date.now() - tradeMs > STALE_THRESHOLD_MS;
}

async function main() {
  mkdirSync("data", { recursive: true });
  const db = openDb(DB_PATH);

  console.log(`Watching wallet: ${WALLET}`);
  console.log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`DB: ${DB_PATH}`);

  while (true) {
    try {
      const trades = await fetchTrades(WALLET, 5);
      let newCount = 0;

      for (const trade of trades) {
        if (isStale(trade)) continue;
        if (hasSeenTrade(db, trade.transactionHash)) continue;

        console.log(formatTrade(trade));
        markTradeSeen(db, trade.transactionHash, WALLET);
        newCount++;
      }

      if (newCount === 0) {
        console.log(`[${new Date().toISOString()}] No new trades.`);
      }
    } catch (err) {
      console.error("Fetch error:", err);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

main();
