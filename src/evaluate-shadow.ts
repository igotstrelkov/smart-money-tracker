// Standalone shadow PnL evaluation script.
// Walks first-BUY alerts that opened shadow positions and replays simple-exit
// logic: closed by leader sell, resolved by market, or still open / unable to value.
// Run on demand: npx tsx src/evaluate-shadow.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

function normalizeOutcome(s: string): string {
  return s.trim().toLowerCase();
}

// Load the current slate.json. Returns a set of lowercase wallet addresses.
// If the file is missing or malformed, returns an empty set and the
// per-leader breakdown falls back to showing everyone (fail-open).
function loadActiveSlate(): Set<string> {
  const slatePath = resolve(process.cwd(), "slate.json");
  try {
    const raw = readFileSync(slatePath, "utf-8");
    const entries = JSON.parse(raw) as Array<{
      address: string;
      name?: string;
    }>;
    return new Set(entries.map((e) => e.address.toLowerCase()));
  } catch (e) {
    console.warn(
      `  [warn] could not load slate.json (${(e as Error).message}); showing all leaders.`,
    );
    return new Set();
  }
}

interface UnableBreakdown {
  marketNotFound: number;
  outcomeNameMismatch: number;
  ghostBook: number;
  noBids: number;
  noEntryPrice: number;
  noClosingSellPrice: number;
  resolvedNonFinitePrice: number;
}

interface RunCounts {
  total: number;
  resolved: number;
  closedBySell: number;
  open: number;
  unableToValue: number;
  unable: UnableBreakdown;
}

function newCounts(): RunCounts {
  return {
    total: 0,
    resolved: 0,
    closedBySell: 0,
    open: 0,
    unableToValue: 0,
    unable: {
      marketNotFound: 0,
      outcomeNameMismatch: 0,
      ghostBook: 0,
      noBids: 0,
      noEntryPrice: 0,
      noClosingSellPrice: 0,
      resolvedNonFinitePrice: 0,
    },
  };
}

async function evaluateShadowedBuys(
  db: ReturnType<typeof openDb>,
  counts: RunCounts,
): Promise<void> {
  // Re-attempt 'open' and 'unable_to_value' positions every run.
  // Don't re-evaluate already-finalized 'resolved' or 'closed_by_sell'.
  const all = getShadowedBuyAlerts(db);
  const buys = all.filter(
    (a) =>
      a.evaluationStatus === "open" || a.evaluationStatus === "unable_to_value",
  );
  console.log(
    `Evaluating ${buys.length} shadow positions (open + unable_to_value)...\n`,
  );

  for (let i = 0; i < buys.length; i++) {
    const buy = buys[i];
    counts.total++;

    if (
      buy.hypotheticalPrice === undefined ||
      buy.hypotheticalSizeUsd === undefined
    ) {
      console.log(
        `  [unable_to_value] ${buy.leaderName}: "${buy.marketTitle}" — no entry price recorded`,
      );
      updateShadowEvaluation(
        db,
        buy.transactionHash,
        null,
        null,
        "unable_to_value",
      );
      counts.unableToValue++;
      counts.unable.noEntryPrice++;
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
          counts.unableToValue++;
          counts.unable.noClosingSellPrice++;
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
          counts.closedBySell++;
        }
        await sleep(DELAY_MS);
        continue;
      }

      // No closing sell — check market resolution / mark-to-market
      const resolution = await fetchMarketResolution(
        buy.conditionId,
        buy.marketSlug,
      );

      if (!resolution) {
        console.log(
          `  [unable_to_value] ${buy.leaderName}: "${buy.marketTitle}" — Gamma returned nothing`,
        );
        updateShadowEvaluation(
          db,
          buy.transactionHash,
          null,
          null,
          "unable_to_value",
        );
        counts.unableToValue++;
        counts.unable.marketNotFound++;
      } else if (resolution.closed) {
        const target = normalizeOutcome(buy.outcome);
        const outcomeIndex = resolution.outcomes.findIndex(
          (o) => normalizeOutcome(o) === target,
        );
        if (outcomeIndex === -1) {
          console.warn(
            `  [unable_to_value] ${buy.leaderName}: outcome "${buy.outcome}" not found in [${resolution.outcomes.join(", ")}] for "${buy.marketTitle}"`,
          );
          updateShadowEvaluation(
            db,
            buy.transactionHash,
            null,
            null,
            "unable_to_value",
          );
          counts.unableToValue++;
          counts.unable.outcomeNameMismatch++;
        } else {
          const finalPrice = resolution.outcomePrices[outcomeIndex];
          if (!Number.isFinite(finalPrice)) {
            console.warn(
              `  [unable_to_value] ${buy.leaderName}: "${buy.marketTitle}" — non-finite outcomePrice ${finalPrice}`,
            );
            updateShadowEvaluation(
              db,
              buy.transactionHash,
              null,
              null,
              "unable_to_value",
            );
            counts.unableToValue++;
            counts.unable.resolvedNonFinitePrice++;
          } else {
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
            counts.resolved++;
          }
        }
      } else {
        // Still trading — mark to current bid.
        // fetchOrderBook already does defensive bid sorting and ghost detection
        // (returns null for ghost books).
        const book = await fetchOrderBook(buy.tokenId);
        if (!book) {
          // Could be 404, empty book, or ghost — all unable_to_value.
          // Categorize as ghostBook since fetchOrderBook collapses these cases.
          console.log(
            `  [unable_to_value] ${buy.leaderName}: "${buy.marketTitle}" — no usable order book`,
          );
          updateShadowEvaluation(
            db,
            buy.transactionHash,
            null,
            null,
            "unable_to_value",
          );
          counts.unableToValue++;
          counts.unable.ghostBook++;
        } else if (!Number.isFinite(book.bestBid) || book.bestBid <= 0) {
          console.log(
            `  [unable_to_value] ${buy.leaderName}: "${buy.marketTitle}" — no bids on book`,
          );
          updateShadowEvaluation(
            db,
            buy.transactionHash,
            null,
            null,
            "unable_to_value",
          );
          counts.unableToValue++;
          counts.unable.noBids++;
        } else {
          const proceedsUsd = shares * book.bestBid;
          const pnlUsd = proceedsUsd - buy.hypotheticalSizeUsd;
          console.log(
            `  [open/mtm] ${buy.leaderName}: "${buy.marketTitle}" ${buy.outcome} → bid $${book.bestBid.toFixed(2)} → ${formatPnl(pnlUsd)}`,
          );
          updateShadowEvaluation(
            db,
            buy.transactionHash,
            proceedsUsd,
            pnlUsd,
            "open",
          );
          counts.open++;
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

function printSummary(counts: RunCounts): void {
  console.log(`
Evaluated ${counts.total} positions:
  resolved:           ${counts.resolved}
  closed_by_sell:     ${counts.closedBySell}
  open (mark-to-mkt): ${counts.open}
  unable_to_value:    ${counts.unableToValue}
    └ unable_to_value breakdown:
        market not found:       ${counts.unable.marketNotFound}
        outcome name mismatch:  ${counts.unable.outcomeNameMismatch}
        ghost / no order book:  ${counts.unable.ghostBook}
        no bids on book:        ${counts.unable.noBids}
        no entry price:         ${counts.unable.noEntryPrice}
        no closing-sell price:  ${counts.unable.noClosingSellPrice}
        non-finite outcome $:   ${counts.unable.resolvedNonFinitePrice}`);
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

  const closedBySell = shadowed.filter(
    (a) => a.evaluationStatus === "closed_by_sell",
  );
  const resolved = shadowed.filter((a) => a.evaluationStatus === "resolved");
  const open = shadowed.filter((a) => a.evaluationStatus === "open");
  const unableToValue = shadowed.filter(
    (a) => a.evaluationStatus === "unable_to_value",
  );

  const realizedClosedPnl = closedBySell.reduce(
    (sum, a) => sum + (a.evaluatedPnlUsd ?? 0),
    0,
  );
  const realizedResolvedPnl = resolved.reduce(
    (sum, a) => sum + (a.evaluatedPnlUsd ?? 0),
    0,
  );
  const unrealizedPnl = open.reduce(
    (sum, a) => sum + (a.evaluatedPnlUsd ?? 0),
    0,
  );
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

  const leaderMap = new Map<string, Alert[]>();
  for (const a of shadowed) {
    const existing = leaderMap.get(a.leaderName) ?? [];
    existing.push(a);
    leaderMap.set(a.leaderName, existing);
  }

  if (leaderMap.size > 0) {
    const activeWallets = loadActiveSlate();

    const activeLeaders: Array<[string, Alert[]]> = [];
    const archivedLeaders: Array<[string, Alert[]]> = [];

    for (const entry of leaderMap) {
      const [, positions] = entry;
      const wallet = positions[0]?.leaderWallet?.toLowerCase() ?? "";
      // If slate didn't load (empty set), treat all as active (fail-open)
      if (activeWallets.size === 0 || activeWallets.has(wallet)) {
        activeLeaders.push(entry);
      } else {
        archivedLeaders.push(entry);
      }
    }

    if (activeLeaders.length > 0) {
      console.log("\n  per-leader breakdown (active slate):");
      for (const [name, positions] of activeLeaders) {
        const closed = positions.filter(
          (a) =>
            a.evaluationStatus === "closed_by_sell" ||
            a.evaluationStatus === "resolved",
        );
        const stillOpen = positions.filter(
          (a) => a.evaluationStatus === "open",
        );
        const realized = closed.reduce(
          (sum, a) => sum + (a.evaluatedPnlUsd ?? 0),
          0,
        );
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

    if (archivedLeaders.length > 0) {
      let archivedPositions = 0;
      let archivedClosed = 0;
      let archivedOpen = 0;
      let archivedRealized = 0;
      let archivedUnrealized = 0;

      for (const [, positions] of archivedLeaders) {
        archivedPositions += positions.length;
        for (const a of positions) {
          if (
            a.evaluationStatus === "closed_by_sell" ||
            a.evaluationStatus === "resolved"
          ) {
            archivedClosed++;
            archivedRealized += a.evaluatedPnlUsd ?? 0;
          } else if (a.evaluationStatus === "open") {
            archivedOpen++;
            archivedUnrealized += a.evaluatedPnlUsd ?? 0;
          }
        }
      }
      const archivedTotal = archivedRealized + archivedUnrealized;

      console.log(
        `\n  [${archivedLeaders.length} archived leaders, not in current slate]:`,
      );
      console.log(
        `    ${archivedPositions} positions  closed ${archivedClosed}, open ${archivedOpen}   ${formatPnl(archivedTotal).padStart(9)} (realized ${formatPnl(archivedRealized)}, unrealized ${formatPnl(archivedUnrealized)})`,
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
  const counts = newCounts();

  await evaluateShadowedBuys(db, counts);
  printSummary(counts);
  printReport(db);
}

main().catch((err) => {
  console.error("Evaluation failed:", err);
  process.exit(1);
});
