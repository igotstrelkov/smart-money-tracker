// Entry point for the smart-money tracker.
// Stage 8: production-ready entry point.
// Polls all wallets, enriches with Gamma + CLOB, sends Telegram alerts,
// logs shadow positions, handles graceful shutdown.

import "dotenv/config";
import { mkdirSync } from "node:fs";
import { fetchTrades } from "./api/data.js";
import type { SlateEntry } from "./config.js";
import { loadConfig, loadSlate } from "./config.js";
import { enrichTrade } from "./enrich.js";
import { sendTelegram } from "./notify.js";
import {
  hasSeenTrade,
  logShadowPosition,
  markTradeSeen,
  openDb,
} from "./store.js";
import type { EnrichedTrade, ShadowPosition, Trade } from "./types.js";

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

  // If we have order book data, use the full enriched format
  if (
    trade.bestAsk !== null &&
    trade.slippage !== null &&
    trade.depthWithin2cUsd !== null
  ) {
    const askStr = trade.bestAsk.toFixed(2);
    const depthStr = trade.depthWithin2cUsd.toFixed(0);
    const slipSign = trade.slippage >= 0 ? "+" : "";
    const slipCents = (trade.slippage * 100).toFixed(0);

    return [
      `🐋 [${name}] ${trade.side} ${trade.outcome} on "${trade.title}"`,
      `Their fill: $${price} × ${size} = $${cost}`,
      `Current ask: $${askStr} ($${depthStr} within 2¢)`,
      `Slippage if you copy: ${slipSign}${slipCents}¢`,
      `→ ${trade.eventUrl}`,
    ].join("\n");
  }

  // Fallback: simple format without order book data
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
  entry: SlateEntry,
  shadowSizeUsd: number,
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

      // Shadow log BUY trades only (buy-and-hold approximation)
      if (trade.side === "BUY") {
        const entryPrice = enriched.bestAsk ?? trade.price + 0.02;
        const shadow: ShadowPosition = {
          transactionHash: trade.transactionHash,
          leaderWallet: entry.address,
          leaderName: entry.name,
          conditionId: trade.conditionId,
          tokenId: trade.asset,
          outcome: trade.outcome,
          side: trade.side,
          leaderFillPrice: trade.price,
          hypotheticalEntryPrice: entryPrice,
          hypotheticalSizeUsd: shadowSizeUsd,
          marketTitle: trade.title,
          marketSlug: trade.slug,
          alertTimestamp: Date.now(),
          evaluationStatus: "open",
          evaluatedAt: null,
          evaluatedValueUsd: null,
          evaluatedPnlUsd: null,
        };
        logShadowPosition(db, shadow);
        console.log(
          `Shadow position logged: ${entry.name} BUY ${trade.outcome} @ $${entryPrice.toFixed(2)} ($${shadowSizeUsd})`,
        );
      }
    } catch (err) {
      console.error(
        `Telegram send failed for tx ${trade.transactionHash.slice(0, 10)}…, will retry next poll:`,
        err,
      );
    }
  }

  return newCount;
}

async function main() {
  const config = loadConfig();
  const slate = loadSlate();

  mkdirSync("data", { recursive: true });
  const db = openDb(DB_PATH);

  // Graceful shutdown
  const shutdown = (signal: string) => {
    console.log(
      `\n[${new Date().toISOString()}] Received ${signal}, shutting down...`,
    );
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Let pm2 restart on unhandled rejections
  process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection, crashing:", err);
    process.exit(1);
  });

  const names = slate.map((e) => e.name).join(", ");
  console.log(`[${new Date().toISOString()}] Smart-money tracker starting`);
  console.log(`Watching ${slate.length} wallets: ${names}`);
  console.log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`Shadow size: $${config.shadowSizeUsd}`);
  console.log(`DB: ${DB_PATH}`);

  while (true) {
    let totalNew = 0;

    for (let i = 0; i < slate.length; i++) {
      try {
        totalNew += await pollWallet(db, slate[i], config.shadowSizeUsd);
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
