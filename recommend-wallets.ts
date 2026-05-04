/**
 * Wallet recommender.
 *
 * Reads the top-wallets-YYYY-MM-DD.json dump produced by
 * discover-top-wallets.ts and outputs a curated shortlist of wallets
 * worth tracking. Not a survey of the data — a recommendation.
 *
 * Selection logic:
 *   1. HARD FILTERS — drop any wallet that fails:
 *      - composite score < 0.85
 *      - last trade > 14 days ago
 *      - unique markets < 30 (too lucky / too narrow)
 *      - verdict contains market-maker, buy-only-bot, or HFT pattern
 *      - trades/day > 100 (too noisy even if clean)
 *
 *   2. CATEGORY DIVERSITY — within each leaderboard category, keep at
 *      most 3 wallets. The point of curation is signal diversity, not
 *      depth in one area.
 *
 *   3. CROSS-CATEGORY BONUS — wallets appearing on multiple category
 *      leaderboards (e.g., OVERALL+SPORTS+POLITICS) get a small score
 *      boost; they're generalists with broader applicability.
 *
 *   4. FREQUENCY PENALTY — wallets above 50 trades/day get a small
 *      score penalty even if technically clean. Without alert filtering
 *      the volume is overwhelming.
 *
 * Output: a single ranked recommendation list, JSON-friendly so it can
 * be piped to slate.json directly if desired.
 *
 * Run with:
 *   npx tsx recommend-wallets.ts [path-to-json]
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";

interface WalletScore {
  address: string;
  userName: string;
  xUsername: string;
  verified: boolean;
  monthlyPnl: number;
  monthlyVol: number;
  categories: string[];
  tradeSample: number;
  spanDays: number;
  buyPct: number;
  tradesPerDay: number;
  medianTradeUsd: number;
  uniqueMarkets: number;
  recentDays: number;
  topMarketShare: number;
  scoreDirectional: number;
  scoreActivityFreq: number;
  scoreTradeSize: number;
  scoreDiversity: number;
  scoreRecency: number;
  scoreNotConcentrated: number;
  compositeScore: number;
  verdict: string;
}

interface Report {
  allScored: WalletScore[];
}

interface Recommendation {
  address: string;
  name: string;
  rationale: string;
  // Diagnostic fields kept for review; safe to drop when piping to slate.json
  primaryCategory: string;
  allCategories: string[];
  adjustedScore: number;
  monthlyPnl: number;
  tradesPerDay: number;
  medianTradeUsd: number;
  uniqueMarkets: number;
  buyPct: number;
}

// ─── Locate input file ───
const explicitPath = process.argv[2];
let filename: string;
if (explicitPath) {
  filename = explicitPath;
} else {
  const files = readdirSync(".").filter((f) => /^top-wallets-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (files.length === 0) {
    console.error("No top-wallets-YYYY-MM-DD.json file found.");
    console.error("Pass an explicit path: npx tsx recommend-wallets.ts <path>");
    process.exit(1);
  }
  filename = files[files.length - 1];
}

console.log(`Reading ${filename}\n`);
const data: Report = JSON.parse(readFileSync(filename, "utf-8"));
const all = data.allScored;
console.log(`  ${all.length} wallets in dataset\n`);

// ─── Stage 1: Hard filters ───
const HARD_FILTER_REASONS = new Map<string, number>();
function passesHardFilter(s: WalletScore): boolean {
  const fail = (reason: string) => {
    HARD_FILTER_REASONS.set(reason, (HARD_FILTER_REASONS.get(reason) ?? 0) + 1);
    return false;
  };

  if (s.compositeScore < 0.85) return fail("composite score < 0.85");
  if (s.recentDays > 14) return fail("inactive >14 days");
  if (s.uniqueMarkets < 30) return fail("too few unique markets (<30)");
  if (s.tradesPerDay > 100) return fail("too noisy (>100 trades/day)");

  const verdict = s.verdict.toLowerCase();
  if (verdict.includes("market-maker")) return fail("market-maker pattern");
  if (verdict.includes("buy-only bot")) return fail("buy-only bot pattern");
  if (verdict.includes("hft scalper")) return fail("HFT scalper pattern");
  if (verdict.includes("dormant")) return fail("dormant");
  if (verdict.includes("single-market")) return fail("single-market concentration");
  if (verdict.includes("low diversity")) return fail("low diversity");
  if (verdict.includes("no trades available")) return fail("no trades available");

  return true;
}

const passed = all.filter(passesHardFilter);
console.log("STAGE 1 — Hard filters\n");
console.log(`  ${passed.length} of ${all.length} pass hard filters\n`);
console.log("  Rejected by reason:");
for (const [reason, count] of [...HARD_FILTER_REASONS.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${count.toString().padStart(3)}  ${reason}`);
}

// ─── Stage 2: Score adjustments ───
function adjustScore(s: WalletScore): number {
  let score = s.compositeScore;

  // Cross-category bonus: appearing on multiple leaderboards is a signal
  // of broader applicability. +0.02 per extra category beyond the first.
  if (s.categories.length > 1) {
    score += 0.02 * Math.min(s.categories.length - 1, 3);
  }

  // Frequency penalty: 50-100 trades/day gets a -0.05 penalty.
  // (>100 already failed hard filter.)
  if (s.tradesPerDay >= 50) {
    score -= 0.05;
  }

  // Diversity bonus for very high market count
  if (s.uniqueMarkets >= 200) score += 0.02;

  return score;
}

const scored = passed.map((s) => ({
  wallet: s,
  adjustedScore: adjustScore(s),
}));

// ─── Stage 3: Pick a primary category for diversity capping ───
// A wallet is primarily of category X if X is its most specific (non-OVERALL)
// category. If only OVERALL, use OVERALL as primary.
function primaryCategory(s: WalletScore): string {
  const nonOverall = s.categories.filter((c) => c !== "OVERALL");
  if (nonOverall.length === 0) return "OVERALL";
  // If multiple non-OVERALL, pick the first deterministically
  return nonOverall.sort()[0];
}

// ─── Stage 4: Greedy diversity-aware selection ───
// Sort by adjusted score, walk down, accept if we haven't already taken
// 3 wallets in that primary category.
const CATEGORY_CAP = 3;
scored.sort((a, b) => b.adjustedScore - a.adjustedScore);

const categoryCount = new Map<string, number>();
const selected: typeof scored = [];

for (const item of scored) {
  const cat = primaryCategory(item.wallet);
  const taken = categoryCount.get(cat) ?? 0;
  if (taken >= CATEGORY_CAP) continue;
  selected.push(item);
  categoryCount.set(cat, taken + 1);
}

console.log("\nSTAGE 2-4 — Score adjustment + category diversity capping\n");
console.log(`  ${selected.length} wallets selected (cap: ${CATEGORY_CAP} per primary category)\n`);

// ─── Stage 5: Generate rationale ───
function rationale(s: WalletScore, primary: string): string {
  const parts: string[] = [];

  // Lead with the most distinctive trait
  if (s.medianTradeUsd >= 5000) {
    parts.push(`high-conviction ($${(s.medianTradeUsd / 1000).toFixed(0)}k median trade)`);
  } else if (s.tradesPerDay <= 5 && s.uniqueMarkets >= 100) {
    parts.push("selective specialist");
  } else if (s.uniqueMarkets >= 250) {
    parts.push("very high diversity");
  } else if (s.categories.length >= 3) {
    parts.push("multi-category generalist");
  } else if (s.buyPct >= 90) {
    parts.push("strongly directional");
  } else {
    parts.push(`${primary.toLowerCase()} specialist`);
  }

  // Add quantitative tag
  parts.push(`$${s.monthlyPnl.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}/mo`);
  parts.push(`${s.uniqueMarkets} markets`);
  parts.push(`${s.tradesPerDay.toFixed(1)}/day`);

  return parts.join(", ");
}

// ─── Build final recommendations ───
const recommendations: Recommendation[] = selected.map((item) => ({
  address: item.wallet.address,
  name: item.wallet.userName,
  rationale: rationale(item.wallet, primaryCategory(item.wallet)),
  primaryCategory: primaryCategory(item.wallet),
  allCategories: item.wallet.categories,
  adjustedScore: Number(item.adjustedScore.toFixed(3)),
  monthlyPnl: Math.round(item.wallet.monthlyPnl),
  tradesPerDay: Number(item.wallet.tradesPerDay.toFixed(1)),
  medianTradeUsd: Math.round(item.wallet.medianTradeUsd),
  uniqueMarkets: item.wallet.uniqueMarkets,
  buyPct: Math.round(item.wallet.buyPct),
}));

// ─── Pretty-print ───
console.log("=".repeat(80));
console.log(" RECOMMENDED WALLETS TO TRACK");
console.log("=".repeat(80));
console.log("");

// Group by primary category for readability
const byCategory = new Map<string, Recommendation[]>();
for (const r of recommendations) {
  if (!byCategory.has(r.primaryCategory)) byCategory.set(r.primaryCategory, []);
  byCategory.get(r.primaryCategory)!.push(r);
}

let i = 1;
for (const [cat, items] of [...byCategory.entries()].sort()) {
  console.log(`── ${cat} (${items.length}) ──\n`);
  for (const r of items) {
    console.log(`${i.toString().padStart(2)}. ${r.name}`);
    console.log(`    ${r.address}`);
    console.log(`    score ${r.adjustedScore}  |  ${r.rationale}`);
    console.log(`    categories: ${r.allCategories.join(", ")}`);
    console.log("");
    i++;
  }
}

// ─── Slate-friendly output ───
const slateFormat = recommendations.map((r) => ({
  address: r.address,
  name: r.name,
  rationale: r.rationale,
}));

const slateFilename = "recommended-slate.json";
writeFileSync(slateFilename, JSON.stringify(slateFormat, null, 2));
console.log("=".repeat(80));
console.log(` ${recommendations.length} wallets recommended`);
console.log(`  Slate-format saved to: ${slateFilename}`);
console.log(`  Rename / merge into slate.json when ready.`);
console.log("=".repeat(80));
