// Entry point for the smart-money tracker.
// Stage 2: polls one hardcoded wallet every 30s and prints trades to console.

import "dotenv/config";
import { fetchTrades } from "./api/data.js";
import type { Trade } from "./types.js";

const WALLET = "0x5bec79df9add70a3892041ab1a5516b60f53b215"; // guongAI
const POLL_INTERVAL_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTrade(trade: Trade): string {
  const side = trade.side;
  const outcome = trade.outcome;
  const price = trade.price.toFixed(2);
  const size = trade.size.toFixed(0);
  const cost = (trade.price * trade.size).toFixed(2);
  const time = new Date(trade.timestamp * 1000).toISOString();
  return `[${time}] ${side} ${outcome} on "${trade.title}" at $${price} × ${size} ($${cost}) — tx:${trade.transactionHash.slice(0, 10)}…`;
}

async function main() {
  console.log(`Watching wallet: ${WALLET}`);
  console.log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s`);

  while (true) {
    try {
      const trades = await fetchTrades(WALLET, 5);
      if (trades.length === 0) {
        console.log("No trades returned.");
      } else {
        for (const trade of trades) {
          console.log(formatTrade(trade));
        }
      }
    } catch (err) {
      console.error("Fetch error:", err);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

main();
