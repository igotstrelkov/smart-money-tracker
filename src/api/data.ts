// Polymarket Data API wrapper.
// Fetches public trade history for any wallet address.
// Endpoint is unauthenticated — plain fetch, no SDK.

import type { Trade } from "../types.js";

interface FetchResult<T> {
  ok: boolean;
  data: T | null;
  status: number;
}

async function fetchJson<T>(url: string): Promise<FetchResult<T>> {
  const res = await fetch(url);
  if (!res.ok) {
    return { ok: false, data: null, status: res.status };
  }
  const data = (await res.json()) as T;
  return { ok: true, data, status: res.status };
}

export async function fetchTrades(
  wallet: string,
  limit: number = 20
): Promise<Trade[]> {
  const url = `https://data-api.polymarket.com/trades?user=${wallet}&limit=${limit}`;
  const result = await fetchJson<Trade[]>(url);

  if (!result.ok || !result.data) {
    console.error(`Failed to fetch trades for ${wallet}: HTTP ${result.status}`);
    return [];
  }

  return result.data;
}
