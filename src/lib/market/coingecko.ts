import type { MarketAsset, PriceSeries } from "@/lib/types";
import { marketCache } from "./cache";
import { datasetHistory } from "./dataset";
import { fallbackHistory, fallbackMarkets } from "./fallback";

const BASE = "https://api.coingecko.com/api/v3";

const MARKETS_TTL = 60_000; // prices move; one minute is plenty for risk work
const HISTORY_TTL = 30 * 60_000; // daily closes only change once a day

export interface FetchResult<T> {
  data: T;
  source: "live" | "fallback";
  notice?: string;
}

function headers(): HeadersInit {
  const key = process.env.COINGECKO_API_KEY;
  return {
    accept: "application/json",
    ...(key ? { "x-cg-demo-api-key": key } : {}),
  };
}

/**
 * Circuit breaker.
 *
 * Without this, an upstream outage costs every single request the full
 * retry-and-backoff budget before falling back — so the page gets *slower*
 * precisely when the data is worst. After a few consecutive failures the
 * breaker opens and requests fail instantly into the fallback path until it
 * times out and lets one probe through.
 */
const breaker = {
  failures: 0,
  openUntil: 0,
  threshold: 3,
  cooldownMs: 60_000,
};

function breakerOpen(): boolean {
  return Date.now() < breaker.openUntil;
}

function recordFailure(): void {
  breaker.failures += 1;
  if (breaker.failures >= breaker.threshold) {
    breaker.openUntil = Date.now() + breaker.cooldownMs;
    breaker.failures = 0;
  }
}

function recordSuccess(): void {
  breaker.failures = 0;
  breaker.openUntil = 0;
}

/**
 * Fetch with bounded retries and exponential backoff.
 *
 * CoinGecko's free tier rate-limits aggressively and intermittently. Retrying
 * once or twice turns most of those into a successful request; retrying
 * forever just turns a slow page into a hung one, so the ceiling is low and
 * the caller always has a fallback path.
 */
async function requestJson<T>(path: string, attempts = 3): Promise<T> {
  if (breakerOpen()) {
    throw new Error("circuit-open");
  }

  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      const res = await fetch(`${BASE}${path}`, {
        headers: headers(),
        signal: controller.signal,
        cache: "no-store",
      });
      clearTimeout(timeout);

      if (res.status === 429) {
        throw new Error("rate-limited");
      }
      if (!res.ok) {
        throw new Error(`upstream ${res.status}`);
      }
      const json = (await res.json()) as T;
      recordSuccess();
      return json;
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
  }

  recordFailure();
  throw lastError instanceof Error ? lastError : new Error("request failed");
}

interface RawMarket {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  market_cap: number;
  total_volume: number;
  price_change_percentage_24h: number | null;
  image: string;
}

export async function getMarkets(limit = 60): Promise<FetchResult<MarketAsset[]>> {
  const key = `markets:${limit}`;
  try {
    const data = await marketCache.fetch(key, MARKETS_TTL, async () => {
      const raw = await requestJson<RawMarket[]>(
        `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false&price_change_percentage=24h`,
      );
      return raw.map(
        (r): MarketAsset => ({
          coinId: r.id,
          symbol: r.symbol.toUpperCase(),
          name: r.name,
          price: r.current_price,
          marketCap: r.market_cap,
          volume24h: r.total_volume,
          change24h: (r.price_change_percentage_24h ?? 0) / 100,
          image: r.image,
        }),
      );
    });
    return { data, source: "live" };
  } catch {
    const stale = marketCache.stale<MarketAsset[]>(key);
    if (stale) {
      return {
        data: stale,
        source: "live",
        notice: "Serving the last successful price snapshot — upstream is rate-limiting.",
      };
    }
    return {
      data: fallbackMarkets(),
      source: "fallback",
      notice:
        "Live price feed unreachable. Showing the bundled reference dataset so the risk engine still has something to work on.",
    };
  }
}

interface RawChart {
  prices: [number, number][];
}

export async function getHistory(
  coinIds: string[],
  days = 90,
): Promise<FetchResult<PriceSeries[]>> {
  const unique = [...new Set(coinIds)];
  const symbolLookup = await symbolMap();

  const results: PriceSeries[] = [];
  let anyFailed = false;

  // Sequential with a small delay: the free tier punishes parallel bursts
  // harder than it punishes slow clients, and a risk dashboard can afford
  // a few hundred milliseconds more than it can afford a 429.
  for (const coinId of unique) {
    const key = `history:${coinId}:${days}`;
    try {
      const series = await marketCache.fetch(key, HISTORY_TTL, async () => {
        const raw = await requestJson<RawChart>(
          `/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=daily`,
        );
        return {
          coinId,
          symbol: symbolLookup[coinId] ?? coinId.slice(0, 4).toUpperCase(),
          timestamps: raw.prices.map(([t]) => t),
          prices: raw.prices.map(([, p]) => p),
        } satisfies PriceSeries;
      });
      results.push(series);
    } catch {
      anyFailed = true;
      const stale = marketCache.stale<PriceSeries>(key);
      if (stale) results.push(stale);
    }
    // Pace requests only while we are actually talking to upstream.
    if (!breakerOpen()) await new Promise((r) => setTimeout(r, 120));
  }

  if (results.length === 0) {
    // Three tiers, tried in order of how much they can be trusted: live, then
    // the committed real dataset, then the synthetic generator. Tier 2 only
    // counts if it covers every requested coin — a matrix half real and half
    // synthetic is worse than one that is honestly all synthetic.
    const committed = datasetHistory(unique, days);
    if (committed) {
      return {
        data: committed,
        source: "fallback",
        notice:
          "Live price feed unreachable. Showing the committed historical dataset — real closes, but not current ones.",
      };
    }

    return {
      data: fallbackHistory(unique, days),
      source: "fallback",
      notice:
        "Historical price feed unreachable and no committed dataset present. Risk figures below are computed on a SYNTHETIC reference dataset — the structure is realistic, the prices are not real.",
    };
  }

  // Backfill anything still missing so the covariance matrix stays complete.
  const have = new Set(results.map((r) => r.coinId));
  const missing = unique.filter((id) => !have.has(id));
  if (missing.length > 0) {
    const committed = datasetHistory(missing, days);
    results.push(...(committed ?? fallbackHistory(missing, days)));
  }

  return {
    data: results,
    source: anyFailed && missing.length > 0 ? "fallback" : "live",
    notice:
      missing.length > 0
        ? `No live history for ${missing.join(", ")} — reference data substituted for those assets.`
        : undefined,
  };
}

let symbolCache: Record<string, string> | null = null;

async function symbolMap(): Promise<Record<string, string>> {
  if (symbolCache) return symbolCache;
  try {
    const markets = await getMarkets(100);
    symbolCache = Object.fromEntries(
      markets.data.map((m) => [m.coinId, m.symbol]),
    );
  } catch {
    symbolCache = {};
  }
  return symbolCache;
}
