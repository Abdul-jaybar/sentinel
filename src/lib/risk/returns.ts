import type { PriceSeries } from "@/lib/types";

/** Simple arithmetic returns: r_t = P_t / P_{t-1} - 1. */
export function simpleReturns(prices: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    if (!prev || !Number.isFinite(prev)) {
      out.push(0);
      continue;
    }
    out.push(prices[i] / prev - 1);
  }
  return out;
}

export function logReturns(prices: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    if (!prev || prev <= 0 || prices[i] <= 0) {
      out.push(0);
      continue;
    }
    out.push(Math.log(prices[i] / prev));
  }
  return out;
}

/**
 * Align a set of price series onto a common daily axis.
 *
 * Upstream feeds return slightly different timestamps per asset (different
 * listing dates, occasional gaps). Computing a covariance matrix across
 * misaligned series silently produces garbage (the classic bug in
 * home-made risk tools), so we intersect on calendar day and forward-fill
 * at most one missing day before dropping an asset.
 */
export function alignSeries(series: PriceSeries[]): {
  timestamps: number[];
  returns: Record<string, number[]>;
  prices: Record<string, number[]>;
  dropped: string[];
} {
  if (series.length === 0) {
    return { timestamps: [], returns: {}, prices: {}, dropped: [] };
  }

  const dayKey = (ts: number) => Math.floor(ts / 86_400_000);

  // Build day -> price maps per asset.
  const maps = series.map((s) => {
    const m = new Map<number, number>();
    for (let i = 0; i < s.timestamps.length; i++) {
      const p = s.prices[i];
      if (Number.isFinite(p) && p > 0) m.set(dayKey(s.timestamps[i]), p);
    }
    return { coinId: s.coinId, map: m };
  });

  // Candidate axis: the days present in the asset with the most observations.
  const anchor = maps.reduce((a, b) => (b.map.size > a.map.size ? b : a));
  const candidateDays = [...anchor.map.keys()].sort((a, b) => a - b);

  const dropped: string[] = [];
  const usable = maps.filter((m) => {
    const coverage =
      candidateDays.filter((d) => m.map.has(d) || m.map.has(d - 1)).length /
      Math.max(1, candidateDays.length);
    if (coverage < 0.8) {
      dropped.push(m.coinId);
      return false;
    }
    return true;
  });

  const days = candidateDays.filter((d) =>
    usable.every((m) => m.map.has(d) || m.map.has(d - 1)),
  );

  const prices: Record<string, number[]> = {};
  for (const m of usable) {
    prices[m.coinId] = days.map((d) => m.map.get(d) ?? m.map.get(d - 1) ?? 0);
  }

  const returns: Record<string, number[]> = {};
  for (const coinId of Object.keys(prices)) {
    returns[coinId] = simpleReturns(prices[coinId]);
  }

  return {
    timestamps: days.map((d) => d * 86_400_000),
    returns,
    prices,
    dropped,
  };
}

/**
 * Portfolio dollar P&L for each historical day:
 *   pnl_t = sum_i notional_i * r_{i,t}
 *
 * Working in dollars rather than weights keeps shorts and levered positions
 * correct without any normalisation gymnastics.
 */
export function portfolioPnlSeries(
  notionals: number[],
  returnMatrix: number[][],
): number[] {
  const days = returnMatrix[0]?.length ?? 0;
  const out = new Array<number>(days).fill(0);
  for (let i = 0; i < notionals.length; i++) {
    const row = returnMatrix[i];
    if (!row) continue;
    for (let t = 0; t < days; t++) out[t] += notionals[i] * row[t];
  }
  return out;
}
