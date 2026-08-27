import { correlationMatrix, symmetricEigenvalues } from "./matrix";
import { quantile } from "./stats";

export interface RegimeCorrelation {
  symbols: string[];
  calm: number[][];
  stressed: number[][];
  /** Exposure-weighted average pairwise correlation in each regime. */
  avgCalm: number;
  avgStressed: number;
  /** avgStressed - avgCalm. The "diversification decay". */
  decay: number;
  calmDays: number;
  stressedDays: number;
  /** Effective independent bets in each regime (see effectiveBets). */
  effectiveBetsCalm: number;
  effectiveBetsStressed: number;
  /** The pair whose correlation rises the most going into stress. */
  worstPair: { a: string; b: string; calm: number; stressed: number } | null;
}

/**
 * Rolling realised volatility of a return series, over a trailing window.
 * The first `window - 1` observations use an expanding window so no day is
 * discarded from the sample.
 */
export function rollingVolatility(returns: number[], window = 7): number[] {
  const out: number[] = [];
  for (let t = 0; t < returns.length; t++) {
    const start = Math.max(0, t - window + 1);
    const slice = returns.slice(start, t + 1);
    const m = slice.reduce((a, b) => a + b, 0) / slice.length;
    const v =
      slice.length > 1
        ? slice.reduce((a, b) => a + (b - m) ** 2, 0) / (slice.length - 1)
        : 0;
    out.push(Math.sqrt(v));
  }
  return out;
}

/**
 * Split the lookback into a calm regime and a stressed regime, and measure the
 * correlation matrix separately in each.
 *
 * This is the core insight the whole product is built on. Correlations
 * estimated over a full sample are an average of two very different worlds. In
 * calm markets a basket of alts genuinely diversifies; in a drawdown they
 * converge toward a single beta trade. A portfolio sized on the blended number
 * is systematically under-hedged exactly when it matters, which is why
 * "diversified" leveraged books get liquidated all at once.
 *
 * IMPORTANT — how the split is defined, and why it is not the obvious one:
 *
 * The intuitive approach is to take the benchmark's worst N days and measure
 * correlation there. That is wrong, and wrong in a direction that would make
 * this tool understate its own headline finding. Conditioning on one tail of
 * the factor truncates the factor's variance within the subsample, which
 * mechanically shrinks the systematic share of each asset's variance and
 * biases measured correlation *downward* — the Boyer et al. / Loretan-English
 * critique of conditional correlation. A naive implementation reports that
 * diversification improves in a crash, which is the opposite of what happens.
 *
 * So the regime is defined by the benchmark's rolling realised VOLATILITY
 * instead: days in the top quartile of trailing 7-day vol are the stressed
 * regime, days in the bottom half are the calm regime. Volatility regimes are
 * two-sided, so they do not truncate the factor distribution, and they line up
 * with what actually drives simultaneous liquidation — sustained high-vol
 * periods rather than one bad print.
 *
 * The classification uses the benchmark only, never the portfolio, so it does
 * not depend on the positions being measured.
 */
export function correlationRegimes(
  symbols: string[],
  returnMatrix: number[][],
  benchmarkReturns: number[],
  weights: number[],
  stressQuantile = 0.75,
): RegimeCorrelation {
  const n = symbols.length;
  const empty: RegimeCorrelation = {
    symbols,
    calm: [],
    stressed: [],
    avgCalm: 0,
    avgStressed: 0,
    decay: 0,
    calmDays: 0,
    stressedDays: 0,
    effectiveBetsCalm: n,
    effectiveBetsStressed: n,
    worstPair: null,
  };
  if (n < 2 || benchmarkReturns.length === 0) return empty;

  const vols = rollingVolatility(benchmarkReturns, 7);
  const stressCut = quantile(vols, stressQuantile);
  const calmCut = quantile(vols, 0.5);

  const stressIdx: number[] = [];
  const calmIdx: number[] = [];
  for (let t = 0; t < vols.length; t++) {
    if (vols[t] >= stressCut) stressIdx.push(t);
    else if (vols[t] <= calmCut) calmIdx.push(t);
    // Days between the two cutoffs belong to neither regime. Leaving a gap
    // keeps the two samples genuinely distinct rather than adjacent slices of
    // one continuum.
  }

  // Need enough observations in each bucket for a meaningful estimate.
  if (stressIdx.length < 8 || calmIdx.length < 8) return empty;

  const slice = (idx: number[]) =>
    returnMatrix.map((row) => idx.map((t) => row[t] ?? 0));

  const calm = correlationMatrix(slice(calmIdx));
  const stressed = correlationMatrix(slice(stressIdx));

  const avg = (m: number[][]) => {
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const w = Math.abs(weights[i]) * Math.abs(weights[j]);
        num += m[i][j] * w;
        den += w;
      }
    }
    return den > 0 ? num / den : 0;
  };

  let worstPair: RegimeCorrelation["worstPair"] = null;
  let worstDelta = -Infinity;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const delta = stressed[i][j] - calm[i][j];
      if (delta > worstDelta) {
        worstDelta = delta;
        worstPair = {
          a: symbols[i],
          b: symbols[j],
          calm: calm[i][j],
          stressed: stressed[i][j],
        };
      }
    }
  }

  const avgCalm = avg(calm);
  const avgStressed = avg(stressed);

  return {
    symbols,
    calm,
    stressed,
    avgCalm,
    avgStressed,
    decay: avgStressed - avgCalm,
    calmDays: calmIdx.length,
    stressedDays: stressIdx.length,
    effectiveBetsCalm: effectiveBets(calm),
    effectiveBetsStressed: effectiveBets(stressed),
    worstPair,
  };
}

/**
 * Effective number of independent bets, via the exponential of the Shannon
 * entropy of the correlation matrix's normalised eigenvalue spectrum:
 *
 *   p_k = lambda_k / sum(lambda)
 *   N_eff = exp( -sum p_k * ln p_k )
 *
 * Counting positions tells you how many tickers you own. This tells you how
 * many genuinely distinct risks you own. A book of eight highly correlated
 * alts scores close to 1 — which is the honest answer, and the one that
 * explains why it behaves like a single levered bet in a sell-off.
 */
export function effectiveBets(corr: number[][]): number {
  const n = corr.length;
  if (n === 0) return 0;
  if (n === 1) return 1;

  const eigenvalues = symmetricEigenvalues(corr).map((v) => Math.max(v, 0));
  const total = eigenvalues.reduce((a, b) => a + b, 0);
  if (total <= 0) return 1;

  let entropy = 0;
  for (const lambda of eigenvalues) {
    const p = lambda / total;
    if (p > 1e-12) entropy -= p * Math.log(p);
  }
  return Math.exp(entropy);
}
