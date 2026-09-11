import type {
  ConcentrationBlock,
  DrawdownPoint,
  LiquidationRisk,
  PerformanceBlock,
  PricedPosition,
} from "@/lib/types";
import { defaultMaintenanceMarginRate, liquidationPrice } from "./cascade";
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
 *
 * TWO BUGS LIVED HERE, AND BOTH ARE WORTH KNOWING ABOUT.
 *
 * 1. Constant notional is not buy-and-hold. The first version walked equity as
 *    `equity += sum_i notional_i * r_{i,t}` with the notionals fixed at today's
 *    values. Holding dollar exposure constant while equity falls is not a
 *    passive book — it is a strategy that re-levers into every drawdown, and it
 *    can drive an *unlevered spot portfolio* to zero, which is impossible. A
 *    real book holds constant QUANTITY and lets exposure shrink with price. So
 *    this now compounds prices along the path and revalues the positions, which
 *    is the same accounting the Monte Carlo and the calibration test use.
 *
 *    (Constant-notional P&L is still exactly right for VaR, which is a
 *    single-period measure where P&L is linear in returns. It is only wrong
 *    when compounded, which is why the two live in different functions.)
 *
 * 2. The account is absorbing at zero. Without a floor a levered book reported
 *    a drawdown of -335%. That is not conservative, it is meaningless: an
 *    account whose equity reaches zero has been closed by the venue, and
 *    everything after is a simulation of trading with money that no longer
 *    exists. The walk now stops there, pins equity to zero and drawdown to -1,
 *    and flags the point as `ruined` so the chart can mark where the book died
 *    instead of drawing a recovery that could never have happened.
 *
 * Drawdown is therefore bounded to [-1, 0] by construction. A value outside
 * that range is always a bug, never a finding.
 */
export function drawdownSeries(
  timestamps: number[],
  positions: PricedPosition[],
  returnMatrix: number[][],
): DrawdownPoint[] {
  const startingEquity = positions.reduce((acc, p) => acc + p.equity, 0);
  const days = returnMatrix[0]?.length ?? 0;
  if (startingEquity <= 0 || days === 0 || positions.length === 0) return [];

  const prices = positions.map((p) => p.price);
  const alive = positions.map(() => true);
  const mmrs = positions.map(
    (p) => p.maintenanceMarginRate ?? defaultMaintenanceMarginRate(p.leverage),
  );

  let peak = startingEquity;
  let ruined = false;
  const out: DrawdownPoint[] = [];

  for (let t = 0; t < days; t++) {
    const timestamp = timestamps[t + 1] ?? timestamps[t] ?? Date.now();

    if (ruined) {
      out.push({ timestamp, equityIndex: 0, drawdown: -1, ruined: true });
      continue;
    }

    for (let i = 0; i < positions.length; i++) {
      if (!alive[i]) continue;
      prices[i] *= 1 + (returnMatrix[i]?.[t] ?? 0);
    }

    let equity = 0;
    for (let i = 0; i < positions.length; i++) {
      if (!alive[i]) continue;
      const p = positions[i];
      const positionEquity =
        p.initialMargin + p.quantity * (prices[i] - p.entryPrice);

      if (p.leverage > 1) {
        const maintenance = Math.abs(p.quantity * prices[i]) * mmrs[i];
        if (positionEquity <= maintenance) {
          alive[i] = false;
          continue;
        }
      } else if (positionEquity <= 0) {
        alive[i] = false;
        continue;
      }
      equity += positionEquity;
    }

    if (equity <= 0) {
      ruined = true;
      out.push({ timestamp, equityIndex: 0, drawdown: -1, ruined: true });
      continue;
    }

    peak = Math.max(peak, equity);
    out.push({
      timestamp,
      equityIndex: equity / startingEquity,
      drawdown: Math.max(-1, Math.min(0, equity / peak - 1)),
      ruined: false,
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

  // Target downside deviation, LPM(2) about a zero target:
  //
  //   DD = sqrt( (1/N) * sum_t min(r_t, 0)^2 )
  //
  // The sum runs over downside days but the average is taken over ALL N
  // observations. Dividing by the count of downside days instead — which is
  // the easy mistake, and what this used to do — inflates the denominator of
  // Sortino and quietly reports a worse ratio than the definition gives.
  const n0 = portfolioReturns.length;
  const downsideDev =
    n0 > 1
      ? Math.sqrt(
          portfolioReturns.reduce((acc, r) => acc + Math.min(r, 0) ** 2, 0) / n0,
        )
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
      drawdowns.length > 0
        ? Math.max(-1, Math.min(...drawdowns.map((d) => d.drawdown)))
        : 0,
    beta: varianceBenchmark > 0 ? covar / varianceBenchmark : 0,
    skewness: skewness(pnlSeries),
    excessKurtosis: excessKurtosis(pnlSeries),
    backcastRuined: drawdowns.some((d) => d.ruined),
    backcastRuinTimestamp: drawdowns.find((d) => d.ruined)?.timestamp ?? null,
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
