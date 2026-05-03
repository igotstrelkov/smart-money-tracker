// Entry point for the smart-money tracker.
// Polls all wallets, enriches with Gamma + CLOB, sends Telegram alerts,
// and logs every alert (BUY/SELL) to the alerts table for shadow PnL tracking.

import "dotenv/config";
import { mkdirSync } from "node:fs";
import { fetchTrades } from "./api/data.js";
import type { SlateEntry } from "./config.js";
import { loadConfig, loadSlate } from "./config.js";
import { enrichTrade } from "./enrich.js";
import { sendTelegram } from "./notify.js";
import {
  findFirstBuyForGroup,
  findRecentAlertForLogicalTrade,
  hasSeenTrade,
  logAlert,
  markTradeSeen,
  openDb,
} from "./store.js";
import type { Alert, EnrichedTrade, Trade } from "./types.js";

const POLL_INTERVAL_MS = 30_000;
const WALLET_DELAY_MS = 200;
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const DUPLICATE_FILL_WINDOW_S = 120; // suppress duplicate Telegram for fills within 2 min
const DB_PATH = "data/tracker.db";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTelegramMessage(name: string, trade: EnrichedTrade): string {
  const price = trade.price.toFixed(2);
  const size = trade.size.toFixed(0);
  const cost = (trade.price * trade.size).toFixed(2);

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
    console.log(formatConsoleLine(entry.name, trade));

    // Duplicate-fill suppression: if we recently alerted for this
    // (leader, market, side), skip the Telegram send but still log.
    const recent = findRecentAlertForLogicalTrade(
      db,
      entry.address,
      trade.conditionId,
      trade.side,
      DUPLICATE_FILL_WINDOW_S,
    );
    const suppressTelegram = recent !== null;

    // Determine shadow tracking fields and hypothetical price.
    let hypotheticalPrice: number | undefined;
    let shadowSize: number | undefined;
    let evaluationStatus: Alert["evaluationStatus"] | undefined;

    if (trade.side === "BUY") {
      hypotheticalPrice = enriched.bestAsk ?? undefined;
      const firstBuy = findFirstBuyForGroup(
        db,
        entry.address,
        trade.conditionId,
        trade.outcome,
      );
      if (firstBuy === null) {
        shadowSize = shadowSizeUsd;
        evaluationStatus = "open";
      }
    } else {
      hypotheticalPrice = enriched.bestBid ?? undefined;
    }

    const alert: Alert = {
      transactionHash: trade.transactionHash,
      leaderWallet: entry.address,
      leaderName: entry.name,
      conditionId: trade.conditionId,
      tokenId: trade.asset,
      outcome: trade.outcome,
      side: trade.side,
      leaderFillPrice: trade.price,
      marketTitle: trade.title,
      marketSlug: trade.slug,
      alertTimestamp: Date.now(),
      hypotheticalPrice,
      hypotheticalSizeUsd: shadowSize,
      evaluationStatus,
    };

    logAlert(db, alert);
    markTradeSeen(db, trade.transactionHash, entry.address);
    newCount++;

    if (evaluationStatus === "open" && hypotheticalPrice !== undefined) {
      console.log(
        `Shadow position opened: ${entry.name} BUY ${trade.outcome} @ $${hypotheticalPrice.toFixed(2)} ($${shadowSize})`,
      );
    }

    if (suppressTelegram) {
      console.log(
        `Telegram suppressed (duplicate fill within ${DUPLICATE_FILL_WINDOW_S}s) for ${entry.name} ${trade.side} on ${trade.title.slice(0, 40)}`,
      );
      continue;
    }

    try {
      await sendTelegram(formatTelegramMessage(entry.name, enriched));
    } catch (err) {
      console.error(
        `Telegram send failed for tx ${trade.transactionHash.slice(0, 10)}…:`,
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

  const shutdown = (signal: string) => {
    console.log(
      `\n[${new Date().toISOString()}] Received ${signal}, shutting down...`,
    );
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

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
