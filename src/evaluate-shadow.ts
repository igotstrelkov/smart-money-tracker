// Standalone shadow PnL evaluation script.
// Walks all shadow positions, marks them to current market state, and prints a report.
// Run on demand: npx tsx src/evaluate-shadow.ts

import { openDb, getAllShadowPositions, getOpenShadowPositions, updateShadowEvaluation } from "./store.js";
import { fetchMarketResolution } from "./api/gamma.js";
import { fetchOrderBook } from "./api/clob.js";
import type { ShadowPosition } from "./types.js";

const DB_PATH = "data/tracker.db";
const DELAY_MS = 200; // gentle pacing between API calls

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evaluateOpenPositions(db: ReturnType<typeof openDb>): Promise<void> {
  const openPositions = getOpenShadowPositions(db);
  console.log(`Evaluating ${openPositions.length} open positions...\n`);

  for (let i = 0; i < openPositions.length; i++) {
    const pos = openPositions[i];
    const sharesHeld = pos.hypotheticalSizeUsd / pos.hypotheticalEntryPrice;

    try {
      const resolution = await fetchMarketResolution(pos.conditionId, pos.marketSlug);

      if (!resolution) {
        console.log(`  [unable_to_value] ${pos.leaderName}: "${pos.marketTitle}" — Gamma returned nothing`);
        updateShadowEvaluation(db, pos.transactionHash, null, null, "unable_to_value");
        await sleep(DELAY_MS);
        continue;
      }

      if (resolution.closed) {
        // Market resolved — find outcome price
        const outcomeIndex = resolution.outcomes.indexOf(pos.outcome);
        if (outcomeIndex === -1) {
          console.log(`  [unable_to_value] ${pos.leaderName}: "${pos.marketTitle}" — outcome "${pos.outcome}" not found in ${JSON.stringify(resolution.outcomes)}`);
          updateShadowEvaluation(db, pos.transactionHash, null, null, "unable_to_value");
        } else {
          const finalPrice = resolution.outcomePrices[outcomeIndex];
          const valueUsd = finalPrice * sharesHeld;
          const pnlUsd = valueUsd - pos.hypotheticalSizeUsd;
          console.log(`  [resolved] ${pos.leaderName}: "${pos.marketTitle}" ${pos.outcome} → $${valueUsd.toFixed(2)} (PnL: ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(2)})`);
          updateShadowEvaluation(db, pos.transactionHash, valueUsd, pnlUsd, "resolved");
        }
      } else {
        // Market still open — mark-to-market using best bid
        const book = await fetchOrderBook(pos.tokenId);
        if (book) {
          const valueUsd = book.bestBid * sharesHeld;
          const pnlUsd = valueUsd - pos.hypotheticalSizeUsd;
          console.log(`  [open/mtm] ${pos.leaderName}: "${pos.marketTitle}" ${pos.outcome} → bid $${book.bestBid.toFixed(2)} → $${valueUsd.toFixed(2)} (PnL: ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(2)})`);
          updateShadowEvaluation(db, pos.transactionHash, valueUsd, pnlUsd, "open");
        } else {
          console.log(`  [open/no-book] ${pos.leaderName}: "${pos.marketTitle}" — no order book available`);
          // Leave as open, don't update value
        }
      }
    } catch (err) {
      console.error(`  [error] ${pos.leaderName}: "${pos.marketTitle}" —`, err);
    }

    if (i < openPositions.length - 1) {
      await sleep(DELAY_MS);
    }
  }
}

function printReport(db: ReturnType<typeof openDb>): void {
  const all = getAllShadowPositions(db);

  if (all.length === 0) {
    console.log("\nNo shadow positions recorded yet.");
    return;
  }

  const resolved = all.filter((p) => p.evaluationStatus === "resolved");
  const open = all.filter((p) => p.evaluationStatus === "open");
  const unableToValue = all.filter((p) => p.evaluationStatus === "unable_to_value");

  const resolvedPnl = resolved.reduce((sum, p) => sum + (p.evaluatedPnlUsd ?? 0), 0);
  const openPnl = open.reduce((sum, p) => sum + (p.evaluatedPnlUsd ?? 0), 0);
  const combinedPnl = resolvedPnl + openPnl;

  const today = new Date().toISOString().slice(0, 10);

  console.log(`
=========================================
 Shadow PnL Report — ${today}
=========================================
  total alerts logged:         ${all.length}
  resolved:                    ${resolved.length}
  still open (mark-to-market): ${open.length}
  unable to value:             ${unableToValue.length}

  resolved PnL:                ${formatPnl(resolvedPnl)}
  open mark-to-market PnL:     ${formatPnl(openPnl)}
  combined PnL:                ${formatPnl(combinedPnl)}`);

  // Per-leader breakdown
  const leaderMap = new Map<string, ShadowPosition[]>();
  for (const p of all) {
    const existing = leaderMap.get(p.leaderName) ?? [];
    existing.push(p);
    leaderMap.set(p.leaderName, existing);
  }

  console.log("\n  per-leader breakdown:");
  for (const [name, positions] of leaderMap) {
    const totalPnl = positions.reduce((sum, p) => sum + (p.evaluatedPnlUsd ?? 0), 0);
    const losses = positions.filter((p) => (p.evaluatedPnlUsd ?? 0) < 0).reduce((sum, p) => sum + (p.evaluatedPnlUsd ?? 0), 0);
    const gains = positions.filter((p) => (p.evaluatedPnlUsd ?? 0) > 0).reduce((sum, p) => sum + (p.evaluatedPnlUsd ?? 0), 0);
    const count = positions.length;
    console.log(`    ${name.padEnd(22)} ${String(count).padStart(3)} alerts  ${formatPnl(totalPnl).padStart(10)}  (${formatPnl(losses)} / ${formatPnl(gains)})`);
  }

  console.log(`
  caveats applied:
  - Buy-and-hold approximation; ignores leader exits
  - Hypothetical entry uses best ask at alert time, not actual fill simulation
  - Open positions valued at current best bid (conservative)
  - Polymarket fees not deducted (real PnL would be ~2% lower)
`);
}

function formatPnl(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}$${value.toFixed(2)}`;
}

async function main() {
  const db = openDb(DB_PATH);

  await evaluateOpenPositions(db);
  printReport(db);
}

main().catch((err) => {
  console.error("Evaluation failed:", err);
  process.exit(1);
});
