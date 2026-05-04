/**
 * Top-10 wallet discovery and scoring.
 *
 * Discovers candidate wallets from Polymarket's leaderboard endpoint,
 * scores each on the behavioural fingerprint we care about (directional,
 * not market-making, recently active, diverse markets, meaningful trade
 * sizes), and returns the top 10 by composite score.
 *
 * Endpoint: GET https://data-api.polymarket.com/v1/leaderboard
 *   - category: OVERALL, POLITICS, SPORTS, CRYPTO, CULTURE, MENTIONS,
 *               WEATHER, ECONOMICS, TECH, FINANCE
 *   - timePeriod: DAY, WEEK, MONTH, ALL
 *   - orderBy: PNL or VOL
 *   - limit: max 50 per request
 *   - offset: max 1000
 *
 * Discovery strategy:
 *   - Pull MONTH-window leaderboards from OVERALL + key categories
 *     (politics, sports, crypto, weather, economics)
 *   - Order by PNL within each
 *   - Dedupe across categories
 *   - Cap discovery at ~150 unique candidates to keep runtime manageable
 *
 * Per-wallet analysis:
 *   - Pull last 1,000 trades via the same /trades endpoint we've used
 *     for planktonXD analysis
 *   - Compute behavioural metrics:
 *     - days_active (span of trades in this sample)
 *     - trades_per_day
 *     - buy_pct
 *     - unique_markets
 *     - top_market_share (concentration)
 *     - median_trade_usd
 *     - days_since_last_trade
 *
 * Composite score:
 *   - Each metric maps to a 0-1 sub-score with explicit thresholds
 *   - Wallets that look like market-makers, HFT bots, dormant whales,
 *     or one-trick concentrators get penalised
 *   - Wallets that look like real directional traders get rewarded
 *
 * Run with:
 *   npx tsx discover-top-wallets.ts
 */

const DATA_API = "https://data-api.polymarket.com";
const USER_AGENT = "polymarket-wallet-discovery (you@example.com)";
const DELAY_MS = 100;

// ───────────────────────── Discovery config ───────────────

// Categories to pull. OVERALL gives the broadest pool; the named
// categories ensure variety (so we don't end up with 10 politics traders).
const DISCOVERY_QUERIES = [
  { category: "OVERALL", timePeriod: "MONTH", orderBy: "PNL" },
  { category: "POLITICS", timePeriod: "MONTH", orderBy: "PNL" },
  { category: "SPORTS", timePeriod: "MONTH", orderBy: "PNL" },
  { category: "CRYPTO", timePeriod: "MONTH", orderBy: "PNL" },
  { category: "WEATHER", timePeriod: "MONTH", orderBy: "PNL" },
  { category: "ECONOMICS", timePeriod: "MONTH", orderBy: "PNL" },
];

// How many top wallets to take per category (after limit=50 per page).
// 50 from each of 6 = up to 300 raw candidates, ~150 unique after dedup.
const PER_CATEGORY_LIMIT = 50;

// Per-wallet analysis cap. 1,000 trades is enough for behavioural
// fingerprinting without making the script run for an hour.
const TRADES_PER_WALLET = 1000;

// How many top-scored wallets to return.
const FINAL_TOP_N = 10;

// ───────────────────────── Types ──────────────────────────

interface LeaderboardEntry {
  rank?: string;
  proxyWallet: string;
  userName?: string;
  vol?: number;
  pnl?: number;
  xUsername?: string;
  verifiedBadge?: boolean;
}

interface Trade {
  proxyWallet?: string;
  side?: string;
  asset?: string;
  conditionId?: string;
  size?: number | string;
  price?: number | string;
  timestamp?: number | string;
  title?: string;
  slug?: string;
  outcome?: string;
}

interface WalletScore {
  address: string;
  userName: string;
  xUsername: string;
  verified: boolean;
  monthlyPnl: number;
  monthlyVol: number;
  categories: string[];

  // Behavioural metrics
  tradeSample: number;
  spanDays: number;
  tradesPerDay: number;
  buyPct: number;
  uniqueMarkets: number;
  topMarketShare: number;
  medianTradeUsd: number;
  recentDays: number;

  // Sub-scores (each 0-1)
  scoreDirectional: number;       // higher buy% = more directional, less MM
  scoreActivityFreq: number;       // sweet spot: 1-20 trades/day
  scoreTradeSize: number;          // bigger lots = more conviction
  scoreDiversity: number;          // more unique markets = more skill, less luck
  scoreRecency: number;            // active in last 7 days
  scoreNotConcentrated: number;    // top market < 30% of trades

  // Composite (weighted average)
  compositeScore: number;

  // Verdict
  verdict: string;
}

// ───────────────────────── Helpers ────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get<T>(url: string): Promise<{ ok: boolean; data: T | null; status: number }> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) return { ok: false, data: null, status: res.status };
    return { ok: true, data: (await res.json()) as T, status: res.status };
  } catch {
    return { ok: false, data: null, status: 0 };
  }
}

function num(x: unknown): number {
  if (typeof x === "number") return x;
  if (typeof x === "string") {
    const v = parseFloat(x);
    return Number.isFinite(v) ? v : 0;
  }
  return 0;
}

function getSide(t: Trade): "BUY" | "SELL" | "?" {
  const s = (t.side ?? "").toString().toUpperCase();
  if (s.includes("BUY")) return "BUY";
  if (s.includes("SELL")) return "SELL";
  return "?";
}

function getTimestampMs(t: Trade): number {
  const ts = t.timestamp;
  if (typeof ts === "number") return ts > 1e12 ? ts : ts * 1000;
  if (typeof ts === "string") {
    const v = parseInt(ts);
    if (Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  }
  return 0;
}

// ───────────────────────── Discovery ──────────────────────

async function discoverCandidates(): Promise<Map<string, LeaderboardEntry & { categories: Set<string> }>> {
  console.log("STEP 1 — Discover candidate wallets from leaderboards\n");
  const candidates = new Map<string, LeaderboardEntry & { categories: Set<string> }>();

  for (const query of DISCOVERY_QUERIES) {
    const url =
      `${DATA_API}/v1/leaderboard` +
      `?category=${query.category}` +
      `&timePeriod=${query.timePeriod}` +
      `&orderBy=${query.orderBy}` +
      `&limit=${PER_CATEGORY_LIMIT}`;
    console.log(`  → ${query.category} / ${query.timePeriod} / by ${query.orderBy}`);
    await sleep(DELAY_MS);
    const r = await get<LeaderboardEntry[]>(url);
    if (!r.ok || !r.data || !Array.isArray(r.data)) {
      console.log(`    ✗ ${r.status}`);
      continue;
    }
    console.log(`    ✓ ${r.data.length} entries`);
    for (const entry of r.data) {
      if (!entry.proxyWallet) continue;
      const existing = candidates.get(entry.proxyWallet);
      if (existing) {
        existing.categories.add(query.category);
      } else {
        candidates.set(entry.proxyWallet, {
          ...entry,
          categories: new Set([query.category]),
        });
      }
    }
  }
  console.log(`\n  ${candidates.size} unique candidate wallets discovered\n`);
  return candidates;
}

// ───────────────────────── Trade fetching ────────────────

async function fetchTrades(wallet: string, max: number): Promise<Trade[]> {
  const all: Trade[] = [];
  let cursor: number | string | null = null;
  const pageSize = 500;

  for (let page = 0; page < Math.ceil(max / pageSize); page++) {
    const url =
      cursor !== null
        ? `${DATA_API}/trades?user=${wallet}&limit=${pageSize}&before=${cursor}`
        : `${DATA_API}/trades?user=${wallet}&limit=${pageSize}`;
    await sleep(DELAY_MS);
    const r = await get<Trade[]>(url);
    if (!r.ok || !r.data || r.data.length === 0) break;
    all.push(...r.data);
    cursor = r.data[r.data.length - 1].timestamp ?? null;
    if (cursor === null) break;
    if (r.data.length < pageSize) break;
  }
  return all.slice(0, max);
}

// ───────────────────────── Scoring ────────────────────────

/** Map a value through three thresholds → 0, 0.5, 1.0 */
function bandedScore(value: number, sweetSpot: [number, number], penaltyZone: [number, number]): number {
  if (value >= sweetSpot[0] && value <= sweetSpot[1]) return 1.0;
  if (value >= penaltyZone[0] && value <= penaltyZone[1]) return 0.5;
  return 0;
}

/** Smooth ramp 0→1 between lo and hi */
function rampScore(value: number, lo: number, hi: number): number {
  if (value <= lo) return 0;
  if (value >= hi) return 1;
  return (value - lo) / (hi - lo);
}

/** Inverse ramp: 1 at lo, 0 at hi */
function inverseRampScore(value: number, lo: number, hi: number): number {
  if (value <= lo) return 1;
  if (value >= hi) return 0;
  return 1 - (value - lo) / (hi - lo);
}

function scoreWallet(
  candidate: LeaderboardEntry & { categories: Set<string> },
  trades: Trade[],
): WalletScore {
  const score: WalletScore = {
    address: candidate.proxyWallet,
    userName: candidate.userName ?? "(no name)",
    xUsername: candidate.xUsername ?? "",
    verified: candidate.verifiedBadge ?? false,
    monthlyPnl: candidate.pnl ?? 0,
    monthlyVol: candidate.vol ?? 0,
    categories: [...candidate.categories],
    tradeSample: trades.length,
    spanDays: 0,
    tradesPerDay: 0,
    buyPct: 0,
    uniqueMarkets: 0,
    topMarketShare: 0,
    medianTradeUsd: 0,
    recentDays: 999,
    scoreDirectional: 0,
    scoreActivityFreq: 0,
    scoreTradeSize: 0,
    scoreDiversity: 0,
    scoreRecency: 0,
    scoreNotConcentrated: 0,
    compositeScore: 0,
    verdict: "",
  };

  if (trades.length === 0) {
    score.verdict = "no trades available";
    return score;
  }

  // ── Behavioural metrics ──
  const timestamps = trades.map(getTimestampMs).filter((t) => t > 0).sort();
  if (timestamps.length > 0) {
    const earliest = timestamps[0];
    const latest = timestamps[timestamps.length - 1];
    score.spanDays = (latest - earliest) / 86400_000;
    score.tradesPerDay = trades.length / Math.max(score.spanDays, 1);
    score.recentDays = (Date.now() - latest) / 86400_000;
  }

  let buys = 0;
  let sells = 0;
  for (const t of trades) {
    const side = getSide(t);
    if (side === "BUY") buys++;
    else if (side === "SELL") sells++;
  }
  const sided = buys + sells;
  score.buyPct = sided > 0 ? (100 * buys) / sided : 0;

  const titles = new Map<string, number>();
  for (const t of trades) {
    const key = (t.title ?? t.slug ?? "(unknown)").toString();
    titles.set(key, (titles.get(key) ?? 0) + 1);
  }
  score.uniqueMarkets = titles.size;
  const topEntry = [...titles.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topEntry) score.topMarketShare = topEntry[1] / trades.length;

  const sizesUsd = trades
    .map((t) => num(t.size) * num(t.price))
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  if (sizesUsd.length > 0) {
    score.medianTradeUsd = sizesUsd[Math.floor(sizesUsd.length / 2)];
  }

  // ── Sub-scores ──

  // 1. Directional: 60-95% buys is the sweet spot (real directional trader)
  //    50/50 = market-maker. 100% buys = either dormant whale or a buy-only bot.
  score.scoreDirectional = bandedScore(score.buyPct, [60, 95], [55, 99]);

  // 2. Activity frequency: 1-20 trades/day is the sweet spot (active but
  //    not a bot). >50/day starts to look HFT. <0.5/day is too dormant.
  score.scoreActivityFreq = bandedScore(score.tradesPerDay, [1, 20], [0.5, 50]);

  // 3. Trade size: median $50+ is meaningful conviction. Below $10 is HFT.
  score.scoreTradeSize = rampScore(score.medianTradeUsd, 10, 100);

  // 4. Diversity: 50+ unique markets is good skill signal. Below 10 = lucky.
  score.scoreDiversity = rampScore(score.uniqueMarkets, 10, 50);

  // 5. Recency: active in last 7 days = full credit. >30 days = zero.
  score.scoreRecency = inverseRampScore(score.recentDays, 7, 30);

  // 6. Not concentrated: top market < 20% of trades. Above 50% = single-market gambler.
  score.scoreNotConcentrated = inverseRampScore(score.topMarketShare, 0.2, 0.5);

  // ── Composite (weighted) ──
  // Weights chosen by what would most damage signal quality:
  // - Recency is hard-required (no point copying inactive wallets)
  // - Directional is critical (filters market-makers like planktonXD)
  // - Activity, size, diversity, concentration all matter equally
  const weights = {
    directional: 0.25,
    activity: 0.15,
    size: 0.15,
    diversity: 0.15,
    recency: 0.20,
    notConcentrated: 0.10,
  };
  score.compositeScore =
    score.scoreDirectional * weights.directional +
    score.scoreActivityFreq * weights.activity +
    score.scoreTradeSize * weights.size +
    score.scoreDiversity * weights.diversity +
    score.scoreRecency * weights.recency +
    score.scoreNotConcentrated * weights.notConcentrated;

  // ── Verdict tags ──
  const tags: string[] = [];
  if (score.buyPct >= 45 && score.buyPct <= 55 && score.tradesPerDay > 20) {
    tags.push("market-maker pattern");
  }
  if (score.medianTradeUsd < 5) tags.push("HFT scalper pattern");
  if (score.recentDays > 30) tags.push("dormant");
  if (score.topMarketShare > 0.5) tags.push("single-market");
  if (score.uniqueMarkets < 5) tags.push("low diversity");
  if (score.buyPct >= 99 && score.tradesPerDay > 10) tags.push("buy-only bot");
  if (tags.length === 0) tags.push("✓ healthy directional trader");
  score.verdict = tags.join(", ");

  return score;
}

// ───────────────────────── Main ───────────────────────────

async function main() {
  console.log("=========================================");
  console.log(" Top-10 wallet discovery and scoring");
  console.log("=========================================\n");

  const candidates = await discoverCandidates();
  if (candidates.size === 0) {
    console.log("No candidates discovered. Check leaderboard endpoint.");
    return;
  }

  console.log(`STEP 2 — Score each candidate (${TRADES_PER_WALLET} trades each)\n`);
  console.log(`  estimated time: ~${Math.ceil((candidates.size * 4 * DELAY_MS) / 1000 / 60)} min\n`);

  const scored: WalletScore[] = [];
  let processed = 0;
  for (const [wallet, candidate] of candidates) {
    processed++;
    process.stdout.write(`  [${processed}/${candidates.size}] ${candidate.userName ?? wallet.slice(0, 10)}... `);
    try {
      const trades = await fetchTrades(wallet, TRADES_PER_WALLET);
      const score = scoreWallet(candidate, trades);
      scored.push(score);
      process.stdout.write(`${trades.length} trades, score ${score.compositeScore.toFixed(2)} (${score.verdict.slice(0, 40)})\n`);
    } catch (e) {
      process.stdout.write(`✗ ${(e as Error).message.slice(0, 60)}\n`);
    }
  }

  // ─── Rank and report ───
  scored.sort((a, b) => b.compositeScore - a.compositeScore);

  console.log("\n=========================================");
  console.log(` Top ${FINAL_TOP_N} wallets by composite score`);
  console.log("=========================================\n");
  console.log(
    "rank".padStart(5) +
      "  " + "name".padEnd(22) +
      "score".padStart(7) +
      "buy%".padStart(7) +
      "tr/day".padStart(8) +
      "med$".padStart(8) +
      "mkts".padStart(6) +
      "rec_d".padStart(7) +
      "  verdict",
  );
  console.log("-".repeat(115));
  for (let i = 0; i < Math.min(FINAL_TOP_N, scored.length); i++) {
    const s = scored[i];
    console.log(
      String(i + 1).padStart(5) +
        "  " + s.userName.slice(0, 22).padEnd(22) +
        s.compositeScore.toFixed(2).padStart(7) +
        s.buyPct.toFixed(0).padStart(7) +
        s.tradesPerDay.toFixed(1).padStart(8) +
        `$${s.medianTradeUsd.toFixed(0)}`.padStart(8) +
        String(s.uniqueMarkets).padStart(6) +
        s.recentDays.toFixed(0).padStart(7) +
        "  " + s.verdict.slice(0, 50),
    );
  }

  console.log("\n=========================================");
  console.log(" Per-wallet detail (top 10)");
  console.log("=========================================\n");
  for (let i = 0; i < Math.min(FINAL_TOP_N, scored.length); i++) {
    const s = scored[i];
    console.log(`${i + 1}. ${s.userName} (${s.address})`);
    if (s.xUsername) console.log(`   X: @${s.xUsername}`);
    console.log(`   categories on leaderboard: ${s.categories.join(", ")}`);
    console.log(`   monthly PnL: $${s.monthlyPnl.toFixed(0)}, volume: $${s.monthlyVol.toFixed(0)}`);
    console.log(`   ${s.tradeSample} trades over ${s.spanDays.toFixed(0)} days, ${s.buyPct.toFixed(0)}% buys`);
    console.log(`   median trade $${s.medianTradeUsd.toFixed(2)}, ${s.uniqueMarkets} unique markets, last trade ${s.recentDays.toFixed(0)}d ago`);
    console.log(`   verdict: ${s.verdict}`);
    console.log(`   sub-scores: directional ${s.scoreDirectional.toFixed(2)}, activity ${s.scoreActivityFreq.toFixed(2)}, size ${s.scoreTradeSize.toFixed(2)}, diversity ${s.scoreDiversity.toFixed(2)}, recency ${s.scoreRecency.toFixed(2)}, not-concentrated ${s.scoreNotConcentrated.toFixed(2)}`);
    console.log("");
  }

  // ─── Structured report ───
  const filename = `top-wallets-${new Date().toISOString().slice(0, 10)}.json`;
  const fs = await import("node:fs");
  fs.writeFileSync(
    filename,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        candidatesDiscovered: candidates.size,
        candidatesScored: scored.length,
        topN: scored.slice(0, FINAL_TOP_N),
        allScored: scored,
      },
      null,
      2,
    ),
  );
  console.log(`Full report saved to ${filename}`);
}

main().catch((e) => {
  console.error("\nDiscovery failed:", e.message);
  process.exit(1);
});
