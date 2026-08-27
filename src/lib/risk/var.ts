import type { RiskContribution, VarBlock } from "@/lib/types";
import {
  cornishFisherQuantile,
  excessKurtosis,
  matrixVectorProduct,
  mean,
  normalInv,
  quadraticForm,
  quantile,
  skewness,
  stdev,
} from "./stats";

/**
 * Three VaR estimators, deliberately reported side by side.
 *
 * They disagree, and the disagreement is the point: when historical VaR is far
 * above parametric VaR, the portfolio's risk is concentrated in a handful of
 * realised tail days rather than in its day-to-day volatility. The UI surfaces
 * that gap instead of hiding behind a single number.
 */
export function computeVar(
  pnlSeries: number[],
  notionals: number[],
  covMatrix: number[][],
  equity: number,
  confidence: number,
): VarBlock {
  const alpha = 1 - confidence;

  // 1. Historical simulation: the empirical alpha-quantile of realised P&L.
  const historicalQuantile = quantile(pnlSeries, alpha);
  const historical = Math.max(0, -historicalQuantile);

  // 2. Expected shortfall: mean of the losses beyond that quantile.
  const tail = pnlSeries.filter((p) => p <= historicalQuantile);
  const expectedShortfall =
    tail.length > 0 ? Math.max(0, -mean(tail)) : historical;

  // 3. Parametric (variance-covariance): sigma_p = sqrt(n' * Sigma * n).
  const portfolioVariance = Math.max(0, quadraticForm(covMatrix, notionals));
  const sigma = Math.sqrt(portfolioVariance);
  const mu = mean(pnlSeries);
  const parametric = Math.max(0, -(mu + normalInv(alpha) * sigma));

  // 4. Cornish-Fisher: parametric, corrected for the skew and fat tails that
  //    make a plain normal assumption dangerous on crypto returns.
  const standardised = sigma > 0 ? pnlSeries.map((p) => (p - mu) / sigma) : [];
  const s = skewness(standardised);
  const k = excessKurtosis(standardised);
  const cfZ = cornishFisherQuantile(alpha, s, k);
  const cornishFisher = Math.max(0, -(mu + cfZ * sigma));

  return {
    confidence,
    historical,
    parametric,
    cornishFisher,
    expectedShortfall,
    pctOfEquity: equity > 0 ? historical / equity : 0,
  };
}

/**
 * Euler decomposition of Expected Shortfall.
 *
 * ES is coherent and homogeneous of degree 1 in position size, so it splits
 * exactly across positions:
 *
 *   ES = sum_i notional_i * ( -E[ r_i | portfolio in tail ] )
 *
 * i.e. each asset is charged with how it behaved specifically on the days the
 * whole portfolio was bleeding. That is a far more useful attribution than
 * position size, because an asset can be small and still own the tail.
 */
export function componentExpectedShortfall(
  symbols: string[],
  coinIds: string[],
  notionals: number[],
  returnMatrix: number[][],
  pnlSeries: number[],
  covMatrix: number[][],
  confidence: number,
  volatilities: number[],
  betas: number[],
): RiskContribution[] {
  const alpha = 1 - confidence;
  const threshold = quantile(pnlSeries, alpha);
  const tailIndices: number[] = [];
  for (let t = 0; t < pnlSeries.length; t++) {
    if (pnlSeries[t] <= threshold) tailIndices.push(t);
  }

  const grossExposure =
    notionals.reduce((acc, n) => acc + Math.abs(n), 0) || 1;

  // Parametric marginal risk: d(sigma_p)/d(n_i) = (Sigma * n)_i / sigma_p.
  const sigma = Math.sqrt(Math.max(0, quadraticForm(covMatrix, notionals)));
  const sigmaN = matrixVectorProduct(covMatrix, notionals);

  const raw = symbols.map((symbol, i) => {
    const row = returnMatrix[i] ?? [];
    const tailReturns = tailIndices.map((t) => row[t] ?? 0);
    const componentES =
      tailReturns.length > 0 ? -notionals[i] * mean(tailReturns) : 0;
    return {
      coinId: coinIds[i],
      symbol,
      notional: notionals[i],
      exposureShare: Math.abs(notionals[i]) / grossExposure,
      componentES,
      esShare: 0,
      marginalVar: sigma > 0 ? sigmaN[i] / sigma : 0,
      volatility: volatilities[i],
      beta: betas[i],
    };
  });

  const totalES = raw.reduce((acc, r) => acc + r.componentES, 0);
  for (const r of raw) {
    r.esShare = totalES !== 0 ? r.componentES / totalES : 0;
  }

  return raw.sort((a, b) => b.componentES - a.componentES);
}

/** Annualised volatility from a daily return series. */
export function annualisedVolatility(returns: number[], periods = 365): number {
  return stdev(returns) * Math.sqrt(periods);
}

/**
 * Histogram of daily P&L, used to draw the loss distribution with the VaR and
 * ES thresholds marked on it.
 */
export function pnlHistogram(
  pnlSeries: number[],
  bins = 28,
): { bin: number; count: number }[] {
  if (pnlSeries.length === 0) return [];
  const lo = Math.min(...pnlSeries);
  const hi = Math.max(...pnlSeries);
  if (lo === hi) return [{ bin: lo, count: pnlSeries.length }];
  const width = (hi - lo) / bins;
  const counts = new Array(bins).fill(0);
  for (const p of pnlSeries) {
    const idx = Math.min(bins - 1, Math.floor((p - lo) / width));
    counts[idx] += 1;
  }
  return counts.map((count, i) => ({ bin: lo + width * (i + 0.5), count }));
}
