// Polymarket Gamma API wrapper.
// Fetches market metadata (title, slug, eventSlug) by condition ID or slug.
// Tries /markets?condition_ids= first, falls back to /events?slug=.
// Endpoint is public/unauthenticated — plain fetch, no SDK.
//
// Note: Gamma's `closed` parameter is binary, not OR-able. Default returns
// only open markets; `closed=true` returns only closed markets. To get a
// market regardless of state, we query both URLs and use whichever returns
// a result.

import type { MarketMeta } from "../types.js";

interface GammaMarketResponse {
  conditionId: string;
  question: string;
  slug: string;
  eventSlug?: string;
  closed?: boolean;
  outcomePrices?: string[];
  outcomes?: string[];
}

interface GammaEventResponse {
  slug: string;
  title: string;
  markets?: GammaMarketResponse[];
}

export interface MarketResolutionInfo {
  conditionId: string;
  closed: boolean;
  outcomePrices: number[];
  outcomes: string[];
}

async function fetchGammaMarketRaw(
  conditionId: string,
): Promise<GammaMarketResponse | null> {
  // Try open-state default first
  const openUrl = `https://gamma-api.polymarket.com/markets?condition_ids=${conditionId}&limit=1`;
  const openRes = await fetch(openUrl);
  if (openRes.ok) {
    const data = (await openRes.json()) as GammaMarketResponse[];
    console.log(`[gamma] ${openUrl} → ${data?.length ?? 0} markets`);
    if (Array.isArray(data) && data.length > 0) return data[0];
  }

  // Retry with closed=true for resolved markets
  const closedUrl = `https://gamma-api.polymarket.com/markets?condition_ids=${conditionId}&closed=true&limit=1`;
  const closedRes = await fetch(closedUrl);
  if (closedRes.ok) {
    const data = (await closedRes.json()) as GammaMarketResponse[];
    console.log(`[gamma] ${closedUrl} → ${data?.length ?? 0} markets`);
    if (Array.isArray(data) && data.length > 0) return data[0];
  }

  return null;
}

async function fetchGammaEventRaw(
  slug: string,
): Promise<GammaEventResponse | null> {
  const openUrl = `https://gamma-api.polymarket.com/events?slug=${slug}&limit=1`;
  const openRes = await fetch(openUrl);
  if (openRes.ok) {
    const data = (await openRes.json()) as GammaEventResponse[];
    console.log(`[gamma] ${openUrl} → ${data?.length ?? 0} events`);
    if (Array.isArray(data) && data.length > 0) return data[0];
  }

  const closedUrl = `https://gamma-api.polymarket.com/events?slug=${slug}&closed=true&limit=1`;
  const closedRes = await fetch(closedUrl);
  if (closedRes.ok) {
    const data = (await closedRes.json()) as GammaEventResponse[];
    console.log(`[gamma] ${closedUrl} → ${data?.length ?? 0} events`);
    if (Array.isArray(data) && data.length > 0) return data[0];
  }

  return null;
}

export async function fetchMarketByConditionId(
  conditionId: string,
  slug?: string
): Promise<MarketMeta | null> {
  const market = await fetchGammaMarketRaw(conditionId);
  if (market) {
    return {
      conditionId: market.conditionId,
      title: market.question,
      slug: market.slug,
      eventSlug: market.eventSlug ?? null,
    };
  }

  if (slug) {
    const event = await fetchGammaEventRaw(slug);
    if (event) {
      return {
        conditionId,
        title: event.title,
        slug: event.slug,
        eventSlug: event.slug,
      };
    }
  }

  console.error(`Gamma API returned no results for ${conditionId}`);
  return null;
}

function parseOutcomePrices(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(Number);
    } catch { /* fall through */ }
  }
  return [];
}

function parseOutcomes(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* fall through */ }
  }
  return [];
}

export async function fetchMarketResolution(
  conditionId: string,
  slug: string
): Promise<MarketResolutionInfo | null> {
  const market = await fetchGammaMarketRaw(conditionId);
  if (market) {
    return {
      conditionId: market.conditionId,
      closed: market.closed ?? false,
      outcomePrices: parseOutcomePrices(market.outcomePrices),
      outcomes: parseOutcomes(market.outcomes),
    };
  }

  const event = await fetchGammaEventRaw(slug);
  if (event) {
    const matched = event.markets?.find((m) => m.conditionId === conditionId);
    if (matched) {
      return {
        conditionId: matched.conditionId,
        closed: matched.closed ?? false,
        outcomePrices: parseOutcomePrices(matched.outcomePrices),
        outcomes: parseOutcomes(matched.outcomes),
      };
    }
    // If no exact conditionId match but only one market, use it
    if (event.markets?.length === 1) {
      const m = event.markets[0];
      return {
        conditionId,
        closed: m.closed ?? false,
        outcomePrices: parseOutcomePrices(m.outcomePrices),
        outcomes: parseOutcomes(m.outcomes),
      };
    }
  }

  return null;
}
