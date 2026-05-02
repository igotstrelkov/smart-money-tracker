// Polymarket CLOB API wrapper.
// Fetches public order book snapshots for a given token ID.
// Defensively sorts bids/asks and detects ghost-book patterns.

export interface OrderBookSnapshot {
  bestBid: number;
  bestAsk: number;
  depthWithin2cUsd: number;
}

interface ClobBookResponse {
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
}

function isGhostBook(bestBid: number, bestAsk: number): boolean {
  return bestBid <= 0.02 && bestAsk >= 0.98;
}

export async function fetchOrderBook(
  tokenId: string
): Promise<OrderBookSnapshot | null> {
  const url = `https://clob.polymarket.com/book?token_id=${tokenId}`;

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`CLOB API error for ${tokenId.slice(0, 10)}…: HTTP ${res.status}`);
    return null;
  }

  const data = (await res.json()) as ClobBookResponse;

  if (!data.bids?.length || !data.asks?.length) {
    return null;
  }

  // Defensively sort: bids descending by price, asks ascending by price
  const bids = data.bids
    .map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
    .sort((a, b) => b.price - a.price);

  const asks = data.asks
    .map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
    .sort((a, b) => a.price - b.price);

  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;

  if (isGhostBook(bestBid, bestAsk)) {
    console.log(`Ghost book detected for token ${tokenId.slice(0, 10)}…, skipping`);
    return null;
  }

  // Compute USD depth within 2¢ of best ask
  let depthWithin2cUsd = 0;
  const ceiling = bestAsk + 0.02;
  for (const ask of asks) {
    if (ask.price > ceiling) break;
    depthWithin2cUsd += ask.price * ask.size;
  }

  return {
    bestBid,
    bestAsk,
    depthWithin2cUsd,
  };
}
