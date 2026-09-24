import type { PriceSeries } from "@/lib/types";
import referenceHistory from "@/data/reference-history.json";

/**
 * The committed reference dataset: real daily closes, checked into the repo.
 *
 * There are three possible sources of price history, in strict order of
 * preference, and the difference between them is visible everywhere:
 *
 *   1. The live CoinGecko feed. Current, but rate-limited and occasionally
 *      down, and it only reaches back as far as the free tier allows.
 *   2. This file. Real historical closes, committed so the app has a long,
 *      reproducible sample offline. This is what makes the historical stress
 *      scenarios `measured` rather than `assumed`, and what gives the
 *      walk-forward validation enough runway to say anything.
 *   3. The synthetic generator in `fallback.ts`. Plausible structure, no
 *      claim to being real, labelled as synthetic on every surface.
 *
 * `npm run fetch:history` rebuilds it. If the file is empty the app is still
 * fine: it drops to (3) and says so. Keeping the three tiers separate, rather
 * than quietly blending them, is what lets the UI always say which one it is
 * showing.
 */

interface RawDataset {
  generatedAt: number;
  source: string;
  note?: string;
  series: {
    coinId: string;
    symbol: string;
    timestamps: number[];
    prices: number[];
  }[];
}

const dataset = referenceHistory as RawDataset;

export interface DatasetInfo {
  available: boolean;
  source: string;
  generatedAt: number;
  coins: string[];
  /** Unix ms of the first and last close present, across all series. */
  firstDay: number | null;
  lastDay: number | null;
  days: number;
}

export function datasetInfo(): DatasetInfo {
  const series = dataset.series ?? [];
  if (series.length === 0) {
    return {
      available: false,
      source: "none",
      generatedAt: 0,
      coins: [],
      firstDay: null,
      lastDay: null,
      days: 0,
    };
  }

  let first = Infinity;
  let last = -Infinity;
  let maxLen = 0;
  for (const s of series) {
    if (s.timestamps.length === 0) continue;
    first = Math.min(first, s.timestamps[0]);
    last = Math.max(last, s.timestamps[s.timestamps.length - 1]);
    maxLen = Math.max(maxLen, s.timestamps.length);
  }

  return {
    available: true,
    source: dataset.source,
    generatedAt: dataset.generatedAt,
    coins: series.map((s) => s.coinId),
    firstDay: Number.isFinite(first) ? first : null,
    lastDay: Number.isFinite(last) ? last : null,
    days: maxLen,
  };
}

/**
 * Series for the requested coins, trimmed to the most recent `days` closes.
 *
 * Returns null unless EVERY requested coin is present. A partial dataset is
 * worse than none: mixing real history for BTC with synthetic history for an
 * alt produces a correlation matrix that is neither, and nothing downstream
 * would be able to tell.
 */
export function datasetHistory(
  coinIds: string[],
  days = 730,
): PriceSeries[] | null {
  const series = dataset.series ?? [];
  if (series.length === 0) return null;

  const byId = new Map(series.map((s) => [s.coinId, s]));
  const out: PriceSeries[] = [];

  for (const coinId of coinIds) {
    const s = byId.get(coinId);
    if (!s || s.timestamps.length < 60) return null;
    const start = Math.max(0, s.timestamps.length - days);
    out.push({
      coinId: s.coinId,
      symbol: s.symbol,
      timestamps: s.timestamps.slice(start),
      prices: s.prices.slice(start),
    });
  }

  return out;
}

/**
 * Full untrimmed series, for the stress scenarios. They need to reach back to
 * 2020, which is far outside any window the dashboard itself displays.
 */
export function datasetFullHistory(coinIds: string[]): PriceSeries[] {
  const series = dataset.series ?? [];
  const byId = new Map(series.map((s) => [s.coinId, s]));
  const out: PriceSeries[] = [];
  for (const coinId of coinIds) {
    const s = byId.get(coinId);
    if (s) {
      out.push({
        coinId: s.coinId,
        symbol: s.symbol,
        timestamps: s.timestamps,
        prices: s.prices,
      });
    }
  }
  return out;
}
