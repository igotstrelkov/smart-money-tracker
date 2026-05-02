// Polymarket Gamma API wrapper.
// Fetches market metadata (title, slug, eventSlug) by condition ID or slug.
// Tries /markets?condition_ids= first, falls back to /events?slug=.
// Endpoint is public/unauthenticated — plain fetch, no SDK.

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

export async function fetchMarketByConditionId(
  conditionId: string,
  slug?: string
): Promise<MarketMeta | null> {
  // Try condition_ids lookup first
  const marketsUrl = `https://gamma-api.polymarket.com/markets?condition_ids=${conditionId}`;
  const marketsRes = await fetch(marketsUrl);

  if (marketsRes.ok) {
    const data = (await marketsRes.json()) as GammaMarketResponse[];
    if (Array.isArray(data) && data.length > 0) {
      const market = data[0];
      return {
        conditionId: market.conditionId,
        title: market.question,
        slug: market.slug,
        eventSlug: market.eventSlug ?? null,
      };
    }
  }

  // Fallback: try events endpoint with slug from the trade
  if (slug) {
    const eventsUrl = `https://gamma-api.polymarket.com/events?slug=${slug}`;
    const eventsRes = await fetch(eventsUrl);

    if (eventsRes.ok) {
      const events = (await eventsRes.json()) as GammaEventResponse[];
      if (Array.isArray(events) && events.length > 0) {
        const event = events[0];
        return {
          conditionId,
          title: event.title,
          slug: event.slug,
          eventSlug: event.slug,
        };
      }
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
  // Try condition_ids first
  const marketsUrl = `https://gamma-api.polymarket.com/markets?condition_ids=${conditionId}`;
  const marketsRes = await fetch(marketsUrl);

  if (marketsRes.ok) {
    const data = (await marketsRes.json()) as GammaMarketResponse[];
    if (Array.isArray(data) && data.length > 0) {
      const m = data[0];
      return {
        conditionId: m.conditionId,
        closed: m.closed ?? false,
        outcomePrices: parseOutcomePrices(m.outcomePrices),
        outcomes: parseOutcomes(m.outcomes),
      };
    }
  }

  // Fallback: events endpoint with slug, find matching market by conditionId
  const eventsUrl = `https://gamma-api.polymarket.com/events?slug=${slug}`;
  const eventsRes = await fetch(eventsUrl);

  if (eventsRes.ok) {
    const events = (await eventsRes.json()) as GammaEventResponse[];
    if (Array.isArray(events) && events.length > 0) {
      const event = events[0];
      const market = event.markets?.find((m) => m.conditionId === conditionId);
      if (market) {
        return {
          conditionId: market.conditionId,
          closed: market.closed ?? false,
          outcomePrices: parseOutcomePrices(market.outcomePrices),
          outcomes: parseOutcomes(market.outcomes),
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
  }

  return null;
}
