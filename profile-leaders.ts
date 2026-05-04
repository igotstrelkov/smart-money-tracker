/**
 * Per-leader strategy profiler.
 *
 * Reads the alerts table and produces a comprehensive JSON dump of
 * each leader's trading patterns. The output is designed for offline
 * inspection — paste it back to an LLM (or read it yourself) to
 * classify each leader's strategy.
 *
 * For each leader, computes:
 *   - Entry-price distribution (buckets across 0-1)
 *   - Hold-time distribution (when positions close by leader sell)
 *   - Win rate and payout asymmetry
 *   - Trades-per-market distribution (one-shot vs scale-in)
 *   - Category concentration
 *   - Time-of-day distribution (UTC hour buckets)
 *   - Buy/sell ratio
 *   - Position outcomes by category
 *
 * Run with:
 *   npx tsx profile-leaders.ts > leader-profiles.json
 */

import Database from "better-sqlite3";

const DB_PATH = process.env.DB_PATH || "data/tracker.db";

interface AlertRow {
  transaction_hash: string;
  leader_wallet: string;
  leader_name: string;
  condition_id: string;
  token_id: string;
  outcome: string;
  side: "BUY" | "SELL";
  leader_fill_price: number;
  market_title: string;
  market_slug: string;
  alert_timestamp: number;
  hypothetical_price: number | null;
  hypothetical_size_usd: number | null;
  evaluation_status: string | null;
  evaluated_at: number | null;
  evaluated_value_usd: number | null;
  evaluated_pnl_usd: number | null;
}

interface LeaderProfile {
  leaderName: string;
  leaderWallet: string;

  // Volume + cadence
  totalAlerts: number;
  buyAlerts: number;
  sellAlerts: number;
  buyPct: number;
  uniqueMarkets: number;
  alertsPerDay: number;
  daysActive: number;
  firstAlertAt: string;
  lastAlertAt: string;

  // Entry-price distribution (buys only)
  entryPriceBuckets: Record<string, number>;
  entryPriceMedian: number;
  entryPriceMean: number;

  // Trades-per-market (one-shot vs scale-in)
  tradesPerMarketBuckets: Record<string, number>;
  avgTradesPerMarket: number;

  // Time-of-day pattern (UTC hour buckets, 0-23)
  hourOfDayBuckets: Record<string, number>;

  // Hold-time distribution (only when leader closed via sell)
  holdTimeBuckets: Record<string, number>;
  positionsClosedByLeader: number;
  positionsHeldToResolution: number;
  positionsStillOpen: number;

  // Outcomes — only meaningful if evaluator has run
  closedPositions: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinUsd: number;
  avgLossUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;

  // Sample of recent trades for visual inspection
  sampleRecentBuys: Array<{
    marketTitle: string;
    outcome: string;
    entryPrice: number;
    timestampUtc: string;
  }>;
}

function bucket(value: number, edges: number[]): string {
  for (let i = 0; i < edges.length - 1; i++) {
    if (value >= edges[i] && value < edges[i + 1]) {
      return `${edges[i].toFixed(2)}-${edges[i + 1].toFixed(2)}`;
    }
  }
  return `>=${edges[edges.length - 1].toFixed(2)}`;
}

function bucketDuration(seconds: number): string {
  if (seconds < 60) return "<1min";
  if (seconds < 600) return "1-10min";
  if (seconds < 3600) return "10min-1h";
  if (seconds < 21600) return "1-6h";
  if (seconds < 86400) return "6-24h";
  if (seconds < 604800) return "1-7d";
  return ">7d";
}

function bucketTradeCount(n: number): string {
  if (n === 1) return "1";
  if (n === 2) return "2";
  if (n <= 5) return "3-5";
  if (n <= 10) return "6-10";
  if (n <= 20) return "11-20";
  return "20+";
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function profileLeader(rows: AlertRow[]): LeaderProfile {
  const leaderName = rows[0].leader_name;
  const leaderWallet = rows[0].leader_wallet;

  const buys = rows.filter((r) => r.side === "BUY");
  const sells = rows.filter((r) => r.side === "SELL");
  const sided = buys.length + sells.length;

  // Time span
  const timestamps = rows.map((r) => r.alert_timestamp).sort((a, b) => a - b);
  const firstMs = timestamps[0];
  const lastMs = timestamps[timestamps.length - 1];
  const daysActive = Math.max(1, (lastMs - firstMs) / 86_400_000);

  // Entry-price distribution (buys only, using hypothetical_price when
  // available else leader_fill_price)
  const entryPrices = buys
    .map((r) => r.hypothetical_price ?? r.leader_fill_price)
    .filter((p) => p > 0 && p < 1);
  const entryEdges = [0.0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0];
  const entryBuckets: Record<string, number> = {};
  for (const e of entryEdges.slice(0, -1)) {
    const next = entryEdges[entryEdges.indexOf(e) + 1];
    entryBuckets[`${e.toFixed(2)}-${next.toFixed(2)}`] = 0;
  }
  for (const p of entryPrices) {
    entryBuckets[bucket(p, entryEdges)] = (entryBuckets[bucket(p, entryEdges)] ?? 0) + 1;
  }

  // Trades per market (number of buy alerts per (condition_id, outcome) group)
  const groupCounts = new Map<string, number>();
  for (const r of buys) {
    const key = `${r.condition_id}::${r.outcome}`;
    groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
  }
  const tpmBuckets: Record<string, number> = { "1": 0, "2": 0, "3-5": 0, "6-10": 0, "11-20": 0, "20+": 0 };
  for (const c of groupCounts.values()) {
    tpmBuckets[bucketTradeCount(c)]++;
  }
  const avgTradesPerMarket = groupCounts.size > 0
    ? buys.length / groupCounts.size
    : 0;

  // Time of day (UTC hour buckets)
  const hourBuckets: Record<string, number> = {};
  for (let h = 0; h < 24; h++) hourBuckets[h.toString().padStart(2, "0")] = 0;
  for (const r of rows) {
    const h = new Date(r.alert_timestamp).getUTCHours();
    hourBuckets[h.toString().padStart(2, "0")]++;
  }

  // Hold time: for each first-buy that has a closing sell, time delta
  // We need to find, per group, the first buy and first sell after it
  const holdTimes: number[] = [];
  let positionsClosedByLeader = 0;
  let positionsHeldToResolution = 0;
  let positionsStillOpen = 0;

  // Iterate over first-buys (rows with evaluation_status set)
  const firstBuys = buys.filter((r) => r.evaluation_status !== null);
  for (const fb of firstBuys) {
    if (fb.evaluation_status === "closed_by_sell" && fb.evaluated_at) {
      const seconds = (fb.evaluated_at - fb.alert_timestamp) / 1000;
      if (seconds >= 0) holdTimes.push(seconds);
      positionsClosedByLeader++;
    } else if (fb.evaluation_status === "resolved") {
      positionsHeldToResolution++;
    } else if (fb.evaluation_status === "open") {
      positionsStillOpen++;
    }
  }

  const holdBuckets: Record<string, number> = {
    "<1min": 0, "1-10min": 0, "10min-1h": 0, "1-6h": 0, "6-24h": 0, "1-7d": 0, ">7d": 0,
  };
  for (const s of holdTimes) holdBuckets[bucketDuration(s)]++;

  // Outcomes
  const closedFirstBuys = firstBuys.filter(
    (r) => r.evaluation_status === "closed_by_sell" || r.evaluation_status === "resolved",
  );
  const wins = closedFirstBuys.filter((r) => (r.evaluated_pnl_usd ?? 0) > 0);
  const losses = closedFirstBuys.filter((r) => (r.evaluated_pnl_usd ?? 0) <= 0);
  const winPnls = wins.map((r) => r.evaluated_pnl_usd ?? 0);
  const lossPnls = losses.map((r) => r.evaluated_pnl_usd ?? 0);
  const realizedPnl = closedFirstBuys.reduce((s, r) => s + (r.evaluated_pnl_usd ?? 0), 0);
  const openFirstBuys = firstBuys.filter((r) => r.evaluation_status === "open");
  const unrealizedPnl = openFirstBuys.reduce((s, r) => s + (r.evaluated_pnl_usd ?? 0), 0);

  // Sample recent buys for visual inspection
  const sampleRecent = buys
    .slice()
    .sort((a, b) => b.alert_timestamp - a.alert_timestamp)
    .slice(0, 8)
    .map((r) => ({
      marketTitle: r.market_title.slice(0, 80),
      outcome: r.outcome,
      entryPrice: r.hypothetical_price ?? r.leader_fill_price,
      timestampUtc: new Date(r.alert_timestamp).toISOString(),
    }));

  return {
    leaderName,
    leaderWallet,
    totalAlerts: rows.length,
    buyAlerts: buys.length,
    sellAlerts: sells.length,
    buyPct: sided > 0 ? Math.round((100 * buys.length) / sided) : 0,
    uniqueMarkets: new Set(rows.map((r) => r.condition_id)).size,
    alertsPerDay: Number((rows.length / daysActive).toFixed(2)),
    daysActive: Number(daysActive.toFixed(1)),
    firstAlertAt: new Date(firstMs).toISOString(),
    lastAlertAt: new Date(lastMs).toISOString(),
    entryPriceBuckets: entryBuckets,
    entryPriceMedian: Number(median(entryPrices).toFixed(3)),
    entryPriceMean: entryPrices.length > 0
      ? Number((entryPrices.reduce((s, p) => s + p, 0) / entryPrices.length).toFixed(3))
      : 0,
    tradesPerMarketBuckets: tpmBuckets,
    avgTradesPerMarket: Number(avgTradesPerMarket.toFixed(2)),
    hourOfDayBuckets: hourBuckets,
    holdTimeBuckets: holdBuckets,
    positionsClosedByLeader,
    positionsHeldToResolution,
    positionsStillOpen,
    closedPositions: closedFirstBuys.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closedFirstBuys.length > 0 ? Number((wins.length / closedFirstBuys.length).toFixed(3)) : 0,
    avgWinUsd: wins.length > 0 ? Number((winPnls.reduce((s, p) => s + p, 0) / wins.length).toFixed(2)) : 0,
    avgLossUsd: losses.length > 0 ? Number((lossPnls.reduce((s, p) => s + p, 0) / losses.length).toFixed(2)) : 0,
    realizedPnlUsd: Number(realizedPnl.toFixed(2)),
    unrealizedPnlUsd: Number(unrealizedPnl.toFixed(2)),
    sampleRecentBuys: sampleRecent,
  };
}

// ─── Main ───
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const allRows = db
  .prepare("SELECT * FROM alerts ORDER BY leader_wallet, alert_timestamp")
  .all() as AlertRow[];

if (allRows.length === 0) {
  console.error("No alerts in database yet. Run the watcher first.");
  process.exit(1);
}

// Group by leader
const byLeader = new Map<string, AlertRow[]>();
for (const row of allRows) {
  if (!byLeader.has(row.leader_wallet)) byLeader.set(row.leader_wallet, []);
  byLeader.get(row.leader_wallet)!.push(row);
}

const profiles: LeaderProfile[] = [];
for (const rows of byLeader.values()) {
  if (rows.length < 5) continue; // skip leaders with too little data
  profiles.push(profileLeader(rows));
}

// Sort by alert volume (most active first)
profiles.sort((a, b) => b.totalAlerts - a.totalAlerts);

const output = {
  generatedAt: new Date().toISOString(),
  totalLeadersWithData: profiles.length,
  totalAlertsAnalyzed: allRows.length,
  leadersExcluded: byLeader.size - profiles.length,
  exclusionReason: "fewer than 5 alerts (insufficient data for profiling)",
  caveats: [
    "Hold times only computed for positions where the leader's first sell closed the position via simple-exit model.",
    "Win rate and PnL are based on shadow-tracked first-BUY positions only. Subsequent buys and all sells are not separately evaluated.",
    "Time-of-day uses UTC. Adjust mentally for the leader's likely time zone if needed.",
    "Strategy classification requires interpretation; the data is descriptive, not diagnostic.",
  ],
  profiles,
};

console.log(JSON.stringify(output, null, 2));
