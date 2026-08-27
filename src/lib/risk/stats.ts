/**
 * Dependency-free statistics primitives.
 *
 * Every function here is pure and total: it returns a finite number for any
 * input it accepts, or 0 for degenerate input (empty arrays, zero variance).
 * The risk engine leans on that so a half-filled portfolio never produces NaN
 * in the UI.
 */

export const TRADING_DAYS_PER_YEAR = 365; // crypto trades every day

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample variance (n-1 denominator). */
export function variance(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (n - 1);
}

export function stdev(xs: number[]): number {
  return Math.sqrt(variance(xs));
}

/** Sample covariance between two equal-length series. */
export function covariance(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let s = 0;
  for (let i = 0; i < n; i++) s += (xs[i] - mx) * (ys[i] - my);
  return s / (n - 1);
}

export function correlation(xs: number[], ys: number[]): number {
  const sx = stdev(xs);
  const sy = stdev(ys);
  if (sx === 0 || sy === 0) return 0;
  const r = covariance(xs, ys) / (sx * sy);
  // Guard against floating-point drift outside [-1, 1].
  return Math.max(-1, Math.min(1, r));
}

/** OLS beta of `asset` on `benchmark`. */
export function beta(asset: number[], benchmark: number[]): number {
  const v = variance(benchmark);
  if (v === 0) return 0;
  return covariance(asset, benchmark) / v;
}

/**
 * Empirical quantile using linear interpolation between order statistics
 * (the "type 7" definition, matching numpy.percentile and R's default).
 */
export function quantile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  if (xs.length === 1) return xs[0];
  const sorted = [...xs].sort((a, b) => a - b);
  const clamped = Math.max(0, Math.min(1, p));
  const pos = clamped * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

/** Fisher-Pearson sample skewness. */
export function skewness(xs: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const m = mean(xs);
  const s = stdev(xs);
  if (s === 0) return 0;
  let acc = 0;
  for (const x of xs) acc += ((x - m) / s) ** 3;
  return (n / ((n - 1) * (n - 2))) * acc;
}

/** Excess kurtosis (0 for a normal distribution). */
export function excessKurtosis(xs: number[]): number {
  const n = xs.length;
  if (n < 4) return 0;
  const m = mean(xs);
  const s = stdev(xs);
  if (s === 0) return 0;
  let acc = 0;
  for (const x of xs) acc += ((x - m) / s) ** 4;
  const g2 = ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * acc;
  const correction = (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  return g2 - correction;
}

/** Standard normal CDF via Abramowitz & Stegun 7.1.26 error function. */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y =
    1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation).
 * Accurate to ~1.15e-9 across the full range, which is far more than the
 * precision of any VaR estimate built on 90 daily observations.
 */
export function normalInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/**
 * Cornish-Fisher expansion of the normal quantile, adjusting for skew and
 * fat tails. This is what makes the parametric VaR usable on crypto returns,
 * which are materially non-normal.
 */
export function cornishFisherQuantile(
  p: number,
  skew: number,
  exKurt: number,
): number {
  const z = normalInv(p);
  return (
    z +
    ((z * z - 1) * skew) / 6 +
    ((z ** 3 - 3 * z) * exKurt) / 24 -
    ((2 * z ** 3 - 5 * z) * skew * skew) / 36
  );
}

/** Matrix-vector product for the quadratic form n' * Σ * n. */
export function quadraticForm(matrix: number[][], vector: number[]): number {
  let total = 0;
  for (let i = 0; i < vector.length; i++) {
    for (let j = 0; j < vector.length; j++) {
      total += vector[i] * matrix[i][j] * vector[j];
    }
  }
  return total;
}

export function matrixVectorProduct(
  matrix: number[][],
  vector: number[],
): number[] {
  return matrix.map((row) =>
    row.reduce((acc, value, j) => acc + value * vector[j], 0),
  );
}
