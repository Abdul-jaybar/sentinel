import type {
  ConcentrationBlock,
  DrawdownPoint,
  LiquidationRisk,
  PerformanceBlock,
  PricedPosition,
} from "@/lib/types";
import { liquidationPrice } from "./cascade";
import {
  TRADING_DAYS_PER_YEAR,
  excessKurtosis,
  mean,
  normalCdf,
  skewness,
  stdev,
} from "./stats";

/**
 * Equity curve and drawdown for the *current* portfolio replayed over history.
 *
 * This is a back-cast, not a track record: it asks "what would today's book
 * have done through the last N days", which is the honest way to give a
 * drawdown figure for a portfolio the user just typed in.
 */
export function drawdownSeries(
  timestamps: number[],
  pnlSeries: number[],
  startingEquity: number,
): DrawdownPoint[] {
  if (startingEquity <= 0 || pnlSeries.length === 0) return [];
  let equity = startingEquity;
  let peak = startingEquity;
  const out: DrawdownPoint[] = [];

  for (let t = 0; t < pnlSeries.length; t++) {
    equity += pnlSeries[t];
    peak = Math.max(peak, equity);
    out.push({
      timestamp: timestamps[t + 1] ?? timestamps[t] ?? Date.now(),
      equityIndex: equity / startingEquity,
      drawdown: peak > 0 ? equity / peak - 1 : 0,
    });
  }
  return out;
}

export function computePerformance(
  pnlSeries: number[],
  startingEquity: number,
  portfolioReturns: number[],
  benchmarkReturns: number[],
  drawdowns: DrawdownPoint[],
): PerformanceBlock {
  const dailyVol = stdev(portfolioReturns);
  const dailyMean = mean(portfolioReturns);

  const downside = portfolioReturns.filter((r) => r < 0);
  const downsideDev =
    downside.length > 1
      ? Math.sqrt(mean(downside.map((r) => r * r)))
      : dailyVol;

  const annualisedVolatility = dailyVol * Math.sqrt(TRADING_DAYS_PER_YEAR);
  const annualisedReturn = dailyMean * TRADING_DAYS_PER_YEAR;

  const varianceBenchmark = stdev(benchmarkReturns) ** 2;
  let covar = 0;
  const n = Math.min(portfolioReturns.length, benchmarkReturns.length);
  if (n > 1) {
    const mp = mean(portfolioReturns.slice(0, n));
    const mb = mean(benchmarkReturns.slice(0, n));
    for (let i = 0; i < n; i++) {
      covar += (portfolioReturns[i] - mp) * (benchmarkReturns[i] - mb);
    }
    covar /= n - 1;
  }

  return {
    annualisedVolatility,
    annualisedReturn,
    sharpe:
      annualisedVolatility > 0 ? annualisedReturn / annualisedVolatility : 0,
    sortino:
      downsideDev > 0
        ? annualisedReturn / (downsideDev * Math.sqrt(TRADING_DAYS_PER_YEAR))
        : 0,
    maxDrawdown:
      drawdowns.length > 0 ? Math.min(...drawdowns.map((d) => d.drawdown)) : 0,
    beta: varianceBenchmark > 0 ? covar / varianceBenchmark : 0,
    skewness: skewness(pnlSeries),
    excessKurtosis: excessKurtosis(pnlSeries),
  };
}

export function computeConcentration(
  positions: PricedPosition[],
  correlationMatrix: number[][],
): ConcentrationBlock {
  const gross =
    positions.reduce((acc, p) => acc + Math.abs(p.notional), 0) || 1;
  const weights = positions.map((p) => Math.abs(p.notional) / gross);

  const hhi = weights.reduce((acc, w) => acc + w * w, 0);
  let topWeight = 0;
  let topSymbol = "—";
  positions.forEach((p, i) => {
    if (weights[i] > topWeight) {
      topWeight = weights[i];
      topSymbol = p.symbol;
    }
  });

  let num = 0;
  let den = 0;
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const w = weights[i] * weights[j];
      num += (correlationMatrix[i]?.[j] ?? 0) * w;
      den += w;
    }
  }

  return {
    hhi,
    effectivePositions: hhi > 0 ? 1 / hhi : 0,
    topWeight,
    topSymbol,
    avgCorrelation: den > 0 ? num / den : 0,
  };
}

/**
 * Per-position liquidation distance, plus the probability of the barrier being
 * touched within the horizon.
 *
 * The touch probability uses the reflection principle for driftless geometric
 * Brownian motion:
 *
 *   P( min_{t<=T} S_t <= B )  =  2 * Phi( ln(B/S) / (sigma * sqrt(T)) )
 *
 * "Touched at any point in the next 30 days" is the number that matters for a
 * liquidation, because being briefly wrong is enough to be closed out — an
 * end-of-period probability materially understates the danger.
 */
export function computeLiquidationRisk(
  positions: PricedPosition[],
  dailyVolatility: Record<string, number>,
  horizonDays = 30,
): LiquidationRisk[] {
  const out: LiquidationRisk[] = [];

  for (const p of positions) {
    const liq = liquidationPrice(p);
    if (liq === null || p.price <= 0) continue;

    const isLong = p.quantity > 0;
    const sigma = dailyVolatility[p.coinId] ?? 0.04;
    const sqrtT = Math.sqrt(horizonDays);

    let probTouch = 0;
    if (sigma > 0) {
      if (isLong && liq < p.price) {
        probTouch = 2 * normalCdf(Math.log(liq / p.price) / (sigma * sqrtT));
      } else if (!isLong && liq > p.price) {
        probTouch = 2 * (1 - normalCdf(Math.log(liq / p.price) / (sigma * sqrtT)));
      } else {
        probTouch = 1;
      }
    }

    out.push({
      coinId: p.coinId,
      symbol: p.symbol,
      leverage: p.leverage,
      side: isLong ? "long" : "short",
      price: p.price,
      liquidationPrice: liq,
      distancePct: Math.abs(liq - p.price) / p.price,
      probTouch30d: Math.max(0, Math.min(1, probTouch)),
      horizonDays,
    });
  }

  return out.sort((a, b) => b.probTouch30d - a.probTouch30d);
}
