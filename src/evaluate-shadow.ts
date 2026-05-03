// Standalone shadow PnL evaluation script.
// Walks first-BUY alerts that opened shadow positions and replays simple-exit
// logic: closed by leader sell, resolved by market, or still open / unable to value.
// Run on demand: npx tsx src/evaluate-shadow.ts

import { fetchOrderBook } from "./api/clob.js";
import { fetchMarketResolution } from "./api/gamma.js";
import {
  findFirstSellAfterBuy,
  getAllAlerts,
  getShadowedBuyAlerts,
  openDb,
  updateShadowEvaluation,
} from "./store.js";
import type { Alert } from "./types.js";

const DB_PATH = "data/tracker.db";
const DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatPnl(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}$${value.toFixed(2)}`;
}

async function evaluateShadowedBuys(db: ReturnType<typeof openDb>): Promise<void> {
  const buys = getShadowedBuyAlerts(db);
  console.log(`Evaluating ${buys.length} shadow positions...\n`);

  for (let i = 0; i < buys.length; i++) {
    const buy = buys[i];

    if (buy.hypotheticalPrice === undefined || buy.hypotheticalSizeUsd === undefined) {
      console.log(
        `  [unable_to_value] ${buy.leaderName}: "${buy.marketTitle}" — no entry price recorded`,
      );
      updateShadowEvaluation(db, buy.transactionHash, null, null, "unable_to_value");
      continue;
    }

    const shares = buy.hypotheticalSizeUsd / buy.hypotheticalPrice;

    try {
      const closingSell = findFirstSellAfterBuy(
        db,
        buy.leaderWallet,
        buy.conditionId,
        buy.outcome,
        buy.alertTimestamp,
      );

      if (closingSell !== null) {
        if (closingSell.hypotheticalPrice === undefined) {
          console.log(
            `  [unable_to_value] ${buy.leaderName}: "${buy.marketTitle}" — closing sell has no price`,
          );
          updateShadowEvaluation(
            db,
            buy.transactionHash,
            null,
            null,
            "unable_to_value",
          );
        } else {
          const proceedsUsd = shares * closingSell.hypotheticalPrice;
          const pnlUsd = proceedsUsd - buy.hypotheticalSizeUsd;
          console.log(
            `  [closed_by_sell] ${buy.leaderName}: "${buy.marketTitle}" ${buy.outcome} → exit $${closingSell.hypotheticalPrice.toFixed(2)} → ${formatPnl(pnlUsd)}`,
          );
          updateShadowEvaluation(
            db,
            buy.transactionHash,
            proceedsUsd,
            pnlUsd,
            "closed_by_sell",
            closingSell.alertTimestamp,
          );
        }
        await sleep(DELAY_MS);
        continue;
      }

      // No closing sell — check market resolution / mark-to-market
      const resolution = await fetchMarketResolution(buy.conditionId, buy.marketSlug);

      if (!resolution) {
        console.log(
          `  [unable_to_value] ${buy.leaderName}: "${buy.marketTitle}" — Gamma returned nothing`,
        );
        updateShadowEvaluation(db, buy.transactionHash, null, null, "unable_to_value");
      } else if (resolution.closed) {
        const outcomeIndex = resolution.outcomes.indexOf(buy.outcome);
        if (outcomeIndex === -1) {
          console.log(
            `  [unable_to_value] ${buy.leaderName}: "${buy.marketTitle}" — outcome "${buy.outcome}" not found in ${JSON.stringify(resolution.outcomes)}`,
          );
          updateShadowEvaluation(
            db,
            buy.transactionHash,
            null,
            null,
            "unable_to_value",
          );
        } else {
          const finalPrice = resolution.outcomePrices[outcomeIndex];
          const proceedsUsd = shares * finalPrice;
          const pnlUsd = proceedsUsd - buy.hypotheticalSizeUsd;
          console.log(
            `  [resolved] ${buy.leaderName}: "${buy.marketTitle}" ${buy.outcome} → $${finalPrice.toFixed(2)} → ${formatPnl(pnlUsd)}`,
          );
          updateShadowEvaluation(
            db,
            buy.transactionHash,
            proceedsUsd,
            pnlUsd,
            "resolved",
          );
        }
      } else {
        const book = await fetchOrderBook(buy.tokenId);
        if (!book) {
          console.log(
            `  [unable_to_value] ${buy.leaderName}: "${buy.marketTitle}" — no order book`,
          );
          updateShadowEvaluation(
            db,
            buy.transactionHash,
            null,
            null,
            "unable_to_value",
          );
        } else {
          const proceedsUsd = shares * book.bestBid;
          const pnlUsd = proceedsUsd - buy.hypotheticalSizeUsd;
          console.log(
            `  [open/mtm] ${buy.leaderName}: "${buy.marketTitle}" ${buy.outcome} → bid $${book.bestBid.toFixed(2)} → ${formatPnl(pnlUsd)}`,
          );
          updateShadowEvaluation(db, buy.transactionHash, proceedsUsd, pnlUsd, "open");
        }
      }
    } catch (err) {
      console.error(`  [error] ${buy.leaderName}: "${buy.marketTitle}" —`, err);
    }

    if (i < buys.length - 1) {
      await sleep(DELAY_MS);
    }
  }
}

function printReport(db: ReturnType<typeof openDb>): void {
  const all = getAllAlerts(db);

  if (all.length === 0) {
    console.log("\nNo alerts recorded yet.");
    return;
  }

  const buyAlerts = all.filter((a) => a.side === "BUY");
  const sellAlerts = all.filter((a) => a.side === "SELL");
  const shadowed = buyAlerts.filter((a) => a.evaluationStatus !== undefined);

  const closedBySell = shadowed.filter((a) => a.evaluationStatus === "closed_by_sell");
  const resolved = shadowed.filter((a) => a.evaluationStatus === "resolved");
  const open = shadowed.filter((a) => a.evaluationStatus === "open");
  const unableToValue = shadowed.filter((a) => a.evaluationStatus === "unable_to_value");

  const realizedClosedPnl = closedBySell.reduce(
    (sum, a) => sum + (a.evaluatedPnlUsd ?? 0),
    0,
  );
  const realizedResolvedPnl = resolved.reduce(
    (sum, a) => sum + (a.evaluatedPnlUsd ?? 0),
    0,
  );
  const unrealizedPnl = open.reduce((sum, a) => sum + (a.evaluatedPnlUsd ?? 0), 0);
  const totalPnl = realizedClosedPnl + realizedResolvedPnl + unrealizedPnl;

  const today = new Date().toISOString().slice(0, 10);

  console.log(`
=========================================
 Shadow PnL Report — ${today}
=========================================
  total alerts logged:         ${all.length} (${buyAlerts.length} buys, ${sellAlerts.length} sells)
  shadow positions opened:     ${shadowed.length}

  closed by leader exit:       ${String(closedBySell.length).padStart(3)}  realized PnL: ${formatPnl(realizedClosedPnl)}
  resolved (held to outcome):  ${String(resolved.length).padStart(3)}  realized PnL: ${formatPnl(realizedResolvedPnl)}
  still open (mark-to-market): ${String(open.length).padStart(3)}  unrealized PnL: ${formatPnl(unrealizedPnl)}
  unable to value:             ${String(unableToValue.length).padStart(3)}

  total realized + unrealized PnL: ${formatPnl(totalPnl)}`);

  // Per-leader breakdown
  const leaderMap = new Map<string, Alert[]>();
  for (const a of shadowed) {
    const existing = leaderMap.get(a.leaderName) ?? [];
    existing.push(a);
    leaderMap.set(a.leaderName, existing);
  }

  if (leaderMap.size > 0) {
    console.log("\n  per-leader breakdown:");
    for (const [name, positions] of leaderMap) {
      const closed = positions.filter(
        (a) => a.evaluationStatus === "closed_by_sell" || a.evaluationStatus === "resolved",
      );
      const stillOpen = positions.filter((a) => a.evaluationStatus === "open");
      const realized = closed.reduce((sum, a) => sum + (a.evaluatedPnlUsd ?? 0), 0);
      const unrealized = stillOpen.reduce(
        (sum, a) => sum + (a.evaluatedPnlUsd ?? 0),
        0,
      );
      const total = realized + unrealized;
      console.log(
        `    ${name.padEnd(24)} ${String(positions.length).padStart(3)} positions  closed ${closed.length}, open ${stillOpen.length}   ${formatPnl(total).padStart(9)} (realized ${formatPnl(realized)}, unrealized ${formatPnl(unrealized)})`,
      );
    }
  }

  console.log(`
  caveats applied:
  - Simple-exit model: each (leader, market, outcome) opens once on first BUY
    and closes once on first subsequent SELL. Multi-stage exits and re-entries
    are not modeled — this can overstate PnL for leaders who scale out of
    losing positions.
  - Hypothetical entry uses best ask at alert time, not actual fill simulation.
  - Hypothetical exit uses best bid at the leader's first sell-alert time.
  - Polymarket fees not deducted (real PnL would be ~2% lower).
`);
}

async function main() {
  const db = openDb(DB_PATH);

  await evaluateShadowedBuys(db);
  printReport(db);
}

main().catch((err) => {
  console.error("Evaluation failed:", err);
  process.exit(1);
});
