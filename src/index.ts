// Entry point for the smart-money tracker.
// Stage 6: polls all wallets, enriches via Gamma cache, sends Telegram alerts.

import "dotenv/config";
import { mkdirSync } from "node:fs";
import { loadSlate } from "./config.js";
import { fetchTrades } from "./api/data.js";
import { openDb, hasSeenTrade, markTradeSeen } from "./store.js";
import { sendTelegram } from "./notify.js";
import { enrichTrade } from "./enrich.js";
import type { Trade, EnrichedTrade } from "./types.js";
import type { SlateEntry } from "./config.js";

const POLL_INTERVAL_MS = 30_000;
const WALLET_DELAY_MS = 200;
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const DB_PATH = "data/tracker.db";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTelegramMessage(name: string, trade: EnrichedTrade): string {
  const price = trade.price.toFixed(2);
  const size = trade.size.toFixed(0);
  const cost = (trade.price * trade.size).toFixed(2);
  return `[${name}] ${trade.side} ${trade.outcome} on "${trade.title}" at $${price} × ${size} ($${cost})\n${trade.eventUrl}`;
}

function formatConsoleLine(name: string, trade: Trade): string {
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

    const enriched = await enrichTrade(db, trade);
    const message = formatTelegramMessage(entry.name, enriched);
    console.log(formatConsoleLine(entry.name, trade));

    try {
      await sendTelegram(message);
      markTradeSeen(db, trade.transactionHash, entry.address);
      newCount++;
    } catch (err) {
      console.error(`Telegram send failed for tx ${trade.transactionHash.slice(0, 10)}…, will retry next poll:`, err);
    }
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
