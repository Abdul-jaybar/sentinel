import type { PricedPosition } from "@/lib/types";
import { covarianceMatrix } from "./matrix";
import { portfolioPnlSeries } from "./returns";
import {
  cornishFisherQuantile,
  excessKurtosis,
  mean,
  normalCdf,
  normalInv,
  quadraticForm,
  quantile,
  skewness,
  stdev,
} from "./stats";
import { simulateSurvival } from "./survival";

/**
 * Model validation.
 *
 * Every other part of Sentinel produces a number. This file asks the only
 * question that decides whether those numbers are worth anything: when the
 * model said 5%, did it happen 5% of the time?
 *
 * A risk tool that has never been backtested is a risk tool that has never
 * been contradicted. Two independent checks live here:
 *
 *   1. VaR exception testing: the standard regulatory battery (Kupiec 1995,
 *      Christoffersen 1998) applied out-of-sample to all three estimators at
 *      once, so the UI can say which one is actually calibrated on *this*
 *      portfolio rather than presenting three numbers and shrugging.
 *
 *   2. Survival calibration: walk-forward reliability of the headline ruin
 *      probability, scored with Brier and reported as a reliability curve.
 *
 * Both are run strictly out-of-sample: every forecast at time t is produced
 * from data ending at t-1 and scored against what happened at t or later.
 */

/* ------------------------------------------------------------------ */
/* Distributions                                                       */
/* ------------------------------------------------------------------ */

/**
 * Upper-tail probability of a chi-squared variate, for the only two degrees of
 * freedom this file needs. Both have closed forms, so there is no series
 * expansion or special-function library anywhere in the path:
 *
 *   df = 1:  P(X > x) = 2 * (1 - Phi(sqrt(x)))      [X = Z^2]
 *   df = 2:  P(X > x) = exp(-x / 2)                 [exponential(1/2)]
 */
export function chiSquareUpperTail(x: number, df: 1 | 2): number {
  if (!Number.isFinite(x) || x <= 0) return 1;
  if (df === 1) return Math.min(1, Math.max(0, 2 * (1 - normalCdf(Math.sqrt(x)))));
  return Math.min(1, Math.max(0, Math.exp(-x / 2)));
}

/** x * ln(x) with the 0 * ln(0) = 0 convention used throughout MLE ratios. */
function xlog(x: number): number {
  return x <= 0 ? 0 : x * Math.log(x);
}

/* ------------------------------------------------------------------ */
/* VaR exception testing                                               */
/* ------------------------------------------------------------------ */

export type VarEstimator = "historical" | "parametric" | "cornish-fisher";

export interface VarExceptionTest {
  estimator: VarEstimator;
  confidence: number;
  /** Out-of-sample days scored. */
  observations: number;
  /** Days the realised loss exceeded the forecast VaR. */
  exceptions: number;
  expectedExceptions: number;
  exceptionRate: number;
  /** Kupiec proportion-of-failures test: is the *rate* right? chi2(1). */
  kupiecLR: number;
  kupiecP: number;
  /** Christoffersen independence: are exceptions *clustered*? chi2(1). */
  independenceLR: number;
  independenceP: number;
  /** Joint test of rate and independence. chi2(2). */
  conditionalCoverageLR: number;
  conditionalCoverageP: number;
  /** Longest run of consecutive exception days. */
  maxConsecutiveExceptions: number;
  /** Mean size of an exception as a multiple of the VaR that was breached. */
  meanExceedanceRatio: number;
  /**
   * "pass": the joint test does not reject at 5%.
   * "marginal": rejected at 5% but not at 1%.
   * "fail": rejected at 1%.
   */
  verdict: "pass" | "marginal" | "fail";
  /** Which sub-test drove a rejection, in plain language. */
  diagnosis: string;
}

/**
 * Kupiec (1995) proportion-of-failures test.
 *
 * Under the null the exception indicator is Bernoulli(p) with p = 1 - c, so the
 * likelihood ratio against the unrestricted MLE pi = x/n is
 *
 *   LR_uc = -2 [ (n-x) ln(1-p) + x ln(p) - (n-x) ln(1-pi) - x ln(pi) ]  ~  chi2(1)
 *
 * It tests the rate and nothing else: ten exceptions spread evenly and ten
 * exceptions on ten consecutive days score identically. That is exactly why the
 * independence test below exists.
 */
export function kupiecTest(
  exceptions: number,
  observations: number,
  p: number,
): { lr: number; pValue: number } {
  const n = observations;
  const x = exceptions;
  if (n === 0 || p <= 0 || p >= 1) return { lr: 0, pValue: 1 };

  const pi = x / n;
  const restricted = (n - x) * Math.log(1 - p) + x * Math.log(p);
  const unrestricted = xlog(n - x) + xlog(x) - xlog(n);
  const lr = Math.max(0, -2 * (restricted - unrestricted));
  return { lr, pValue: chiSquareUpperTail(lr, 1) };
}

/**
 * Christoffersen (1998) independence test.
 *
 * Treats the exception sequence as a two-state Markov chain and asks whether
 * P(exception | exception yesterday) differs from P(exception | no exception
 * yesterday). Clustered exceptions are the dangerous failure: a model can have
 * a perfect long-run rate and still put every one of its misses inside the same
 * week, which for a leveraged account is the difference between a bad month and
 * a closed account.
 */
export function christoffersenIndependence(hits: boolean[]): {
  lr: number;
  pValue: number;
  transitions: { n00: number; n01: number; n10: number; n11: number };
} {
  let n00 = 0;
  let n01 = 0;
  let n10 = 0;
  let n11 = 0;

  for (let t = 1; t < hits.length; t++) {
    const prev = hits[t - 1];
    const cur = hits[t];
    if (!prev && !cur) n00 += 1;
    else if (!prev && cur) n01 += 1;
    else if (prev && !cur) n10 += 1;
    else n11 += 1;
  }

  const transitions = { n00, n01, n10, n11 };
  const total = n00 + n01 + n10 + n11;
  if (total === 0) return { lr: 0, pValue: 1, transitions };

  // Unrestricted: separate transition probabilities from each state.
  const unrestricted =
    xlog(n00) + xlog(n01) - xlog(n00 + n01) +
    xlog(n10) + xlog(n11) - xlog(n10 + n11);

  // Restricted: one common probability, i.e. independence.
  const ones = n01 + n11;
  const zeros = n00 + n10;
  const restricted = xlog(zeros) + xlog(ones) - xlog(total);

  const lr = Math.max(0, -2 * (restricted - unrestricted));
  return { lr, pValue: chiSquareUpperTail(lr, 1), transitions };
}

/** Forecast 1-day VaR from a training window, for one estimator. */
function forecastVar(
  trainingPnl: number[],
  notionals: number[],
  trainingReturns: number[][],
  alpha: number,
  estimator: VarEstimator,
): number {
  if (trainingPnl.length < 2) return 0;

  if (estimator === "historical") {
    return Math.max(0, -quantile(trainingPnl, alpha));
  }

  const cov = covarianceMatrix(trainingReturns);
  const sigma = Math.sqrt(Math.max(0, quadraticForm(cov, notionals)));
  const mu = mean(trainingPnl);

  if (estimator === "parametric") {
    return Math.max(0, -(mu + normalInv(alpha) * sigma));
  }

  const standardised = sigma > 0 ? trainingPnl.map((p) => (p - mu) / sigma) : [];
  const z = cornishFisherQuantile(
    alpha,
    skewness(standardised),
    excessKurtosis(standardised),
  );
  return Math.max(0, -(mu + z * sigma));
}

function verdictFor(p: number): "pass" | "marginal" | "fail" {
  if (p >= 0.05) return "pass";
  if (p >= 0.01) return "marginal";
  return "fail";
}

/**
 * Walk the history one day at a time, forecasting VaR from a rolling window
 * that ends the day before, and score the forecasts against what happened.
 *
 * The window is rolling rather than expanding on purpose. Crypto volatility is
 * not stationary over multi-year samples, and an expanding window would keep
 * 2021 in the estimate forever; a rolling window is what a desk would actually
 * run, and it makes the test harder rather than easier.
 */
export function backtestVar(
  positions: PricedPosition[],
  returnMatrix: number[][],
  options: {
    confidence?: number;
    trainWindow?: number;
    estimators?: VarEstimator[];
  } = {},
): VarExceptionTest[] {
  const confidence = options.confidence ?? 0.95;
  const trainWindow = options.trainWindow ?? 120;
  const estimators =
    options.estimators ?? (["historical", "parametric", "cornish-fisher"] as const).slice();

  const alpha = 1 - confidence;
  const notionals = positions.map((p) => p.notional);
  const pnl = portfolioPnlSeries(notionals, returnMatrix);
  const nDays = pnl.length;

  if (nDays <= trainWindow + 10) {
    return estimators.map((estimator) => ({
      estimator,
      confidence,
      observations: 0,
      exceptions: 0,
      expectedExceptions: 0,
      exceptionRate: 0,
      kupiecLR: 0,
      kupiecP: 1,
      independenceLR: 0,
      independenceP: 1,
      conditionalCoverageLR: 0,
      conditionalCoverageP: 1,
      maxConsecutiveExceptions: 0,
      meanExceedanceRatio: 0,
      verdict: "pass" as const,
      diagnosis: `Not enough history: ${nDays} days available, ${
        trainWindow + 11
      } needed to score even ten out-of-sample days.`,
    }));
  }

  return estimators.map((estimator) => {
    const hits: boolean[] = [];
    const exceedanceRatios: number[] = [];

    for (let t = trainWindow; t < nDays; t++) {
      const trainingPnl = pnl.slice(t - trainWindow, t);
      const trainingReturns = returnMatrix.map((row) =>
        row.slice(t - trainWindow, t),
      );
      const varForecast = forecastVar(
        trainingPnl,
        notionals,
        trainingReturns,
        alpha,
        estimator,
      );
      const loss = -pnl[t];
      const hit = varForecast > 0 && loss > varForecast;
      hits.push(hit);
      if (hit) exceedanceRatios.push(loss / varForecast);
    }

    const observations = hits.length;
    const exceptions = hits.filter(Boolean).length;
    const kupiec = kupiecTest(exceptions, observations, alpha);
    const independence = christoffersenIndependence(hits);
    const ccLR = kupiec.lr + independence.lr;
    const ccP = chiSquareUpperTail(ccLR, 2);

    let run = 0;
    let maxRun = 0;
    for (const h of hits) {
      run = h ? run + 1 : 0;
      maxRun = Math.max(maxRun, run);
    }

    const exceptionRate = observations > 0 ? exceptions / observations : 0;
    const verdict = verdictFor(ccP);

    let diagnosis: string;
    if (verdict === "pass") {
      diagnosis = `${exceptions} exceptions in ${observations} days against ${(
        alpha * observations
      ).toFixed(1)} expected; rate and clustering both consistent with the model.`;
    } else if (kupiec.pValue < 0.05 && independence.pValue >= 0.05) {
      diagnosis =
        exceptionRate > alpha
          ? `Too many exceptions (${(exceptionRate * 100).toFixed(1)}% vs ${(
              alpha * 100
            ).toFixed(1)}% expected). This estimator understates the risk.`
          : `Too few exceptions (${(exceptionRate * 100).toFixed(1)}% vs ${(
              alpha * 100
            ).toFixed(1)}% expected). It is too conservative, so capital is being wasted.`;
    } else if (independence.pValue < 0.05 && kupiec.pValue >= 0.05) {
      diagnosis = `Right number of exceptions, wrong shape: they cluster (longest run ${maxRun} days). The model reacts to volatility too slowly.`;
    } else {
      diagnosis = `Both the rate (${(exceptionRate * 100).toFixed(
        1,
      )}%) and the clustering (longest run ${maxRun} days) reject.`;
    }

    return {
      estimator,
      confidence,
      observations,
      exceptions,
      expectedExceptions: alpha * observations,
      exceptionRate,
      kupiecLR: kupiec.lr,
      kupiecP: kupiec.pValue,
      independenceLR: independence.lr,
      independenceP: independence.pValue,
      conditionalCoverageLR: ccLR,
      conditionalCoverageP: ccP,
      maxConsecutiveExceptions: maxRun,
      meanExceedanceRatio:
        exceedanceRatios.length > 0 ? mean(exceedanceRatios) : 0,
      verdict,
      diagnosis,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Survival calibration                                                */
/* ------------------------------------------------------------------ */

export interface ReliabilityBin {
  lower: number;
  upper: number;
  count: number;
  meanPredicted: number;
  observedFrequency: number;
}

export interface SurvivalCalibration {
  /** Number of walk-forward origins scored. */
  origins: number;
  horizonDays: number;
  ruinThreshold: number;
  trainWindow: number;
  pathsPerOrigin: number;
  /** Mean squared error of the probability forecast. Lower is better. */
  brierScore: number;
  /** Brier score of always predicting the sample base rate. */
  climatologyBrier: number;
  /** 1 - brier/climatology. Positive means the model beats "always the same". */
  brierSkillScore: number;
  meanPredicted: number;
  observedRate: number;
  /** Mean forecast minus observed frequency. Positive = over-forecasting. */
  bias: number;
  /**
   * Origins are spaced `stride` days apart but score overlapping horizons, so
   * neighbouring outcomes are not independent. This is the honest sample size:
   * roughly the number of non-overlapping horizons the window contains.
   */
  effectiveSampleSize: number;
  bins: ReliabilityBin[];
  notes: string[];
}

/**
 * Did the ruin probability mean anything?
 *
 * For each origin t: fit on the `trainWindow` days ending at t, run the same
 * block-bootstrap simulation the dashboard runs, and record the forecast ruin
 * probability. Then walk the *actual* returns from t forward over the horizon,
 * with the same liquidation logic, and record whether the account really did
 * breach the ruin threshold. Score the pairs.
 *
 * Two things are deliberately not hidden:
 *
 *  - Overlapping horizons. Origins `stride` days apart share most of their
 *    outcome window, so the outcomes are strongly autocorrelated and the
 *    nominal count overstates the evidence. `effectiveSampleSize` reports the
 *    number of non-overlapping horizons instead, and it is usually small.
 *
 *  - In-sample resampling. The bootstrap draws from the training window, and
 *    the realised path is the window immediately after it. When volatility
 *    regime-shifts across that boundary the model will look badly calibrated,
 *    which is a true statement about the model, not a bug in the test.
 *
 * A model that is well calibrated on a 300-day crypto sample is not proven
 * correct. A model that is badly calibrated on one is proven wrong, and that
 * asymmetry is the entire value of running this.
 */
export function calibrateSurvival(
  positions: PricedPosition[],
  returnMatrix: number[][],
  options: {
    horizonDays?: number;
    trainWindow?: number;
    stride?: number;
    pathsPerOrigin?: number;
    ruinThreshold?: number;
    bins?: number;
  } = {},
): SurvivalCalibration | null {
  const horizonDays = options.horizonDays ?? 30;
  const trainWindow = options.trainWindow ?? 120;
  const stride = options.stride ?? 3;
  const pathsPerOrigin = options.pathsPerOrigin ?? 400;
  const ruinThreshold = options.ruinThreshold ?? 0.5;
  const binCount = options.bins ?? 5;

  const nDays = returnMatrix[0]?.length ?? 0;
  const startingEquity = positions.reduce((acc, p) => acc + p.equity, 0);

  if (
    positions.length === 0 ||
    startingEquity <= 0 ||
    nDays < trainWindow + horizonDays + stride
  ) {
    return null;
  }

  const predictions: number[] = [];
  const outcomes: number[] = [];

  for (
    let origin = trainWindow;
    origin + horizonDays <= nDays;
    origin += stride
  ) {
    const training = returnMatrix.map((row) =>
      row.slice(origin - trainWindow, origin),
    );

    const forecast = simulateSurvival(positions, training, {
      horizonDays,
      paths: pathsPerOrigin,
      ruinThreshold,
      // Vary the seed by origin so successive forecasts are not the same draw
      // replayed; the run stays fully deterministic for a given portfolio.
      seed: origin,
    });

    const realised = realisedRuin(
      positions,
      returnMatrix,
      origin,
      horizonDays,
      ruinThreshold,
    );

    predictions.push(forecast.ruinProbability);
    outcomes.push(realised ? 1 : 0);
  }

  if (predictions.length === 0) return null;

  const brierScore = mean(predictions.map((p, i) => (p - outcomes[i]) ** 2));
  const observedRate = mean(outcomes);
  const climatologyBrier = mean(
    outcomes.map((o) => (observedRate - o) ** 2),
  );
  const meanPredicted = mean(predictions);

  // Reliability curve: equal-width probability bins.
  const bins: ReliabilityBin[] = [];
  for (let b = 0; b < binCount; b++) {
    const lower = b / binCount;
    const upper = (b + 1) / binCount;
    const idx: number[] = [];
    for (let i = 0; i < predictions.length; i++) {
      const p = predictions[i];
      if (p >= lower && (p < upper || (b === binCount - 1 && p <= upper))) {
        idx.push(i);
      }
    }
    bins.push({
      lower,
      upper,
      count: idx.length,
      meanPredicted: idx.length > 0 ? mean(idx.map((i) => predictions[i])) : 0,
      observedFrequency: idx.length > 0 ? mean(idx.map((i) => outcomes[i])) : 0,
    });
  }

  const spanDays = (predictions.length - 1) * stride + horizonDays;
  const effectiveSampleSize = Math.max(1, Math.floor(spanDays / horizonDays));

  const notes: string[] = [
    `${predictions.length} origins scored, but the horizons overlap: about ${effectiveSampleSize} independent ${horizonDays}-day windows of evidence.`,
  ];
  if (effectiveSampleSize < 10) {
    notes.push(
      "That is too little evidence to confirm the model. It is enough to detect gross miscalibration, which is what this panel is for.",
    );
  }
  if (observedRate === 0) {
    notes.push(
      "The account never actually breached the ruin threshold in this sample, so the Brier score only measures how confidently the model said so.",
    );
  }

  return {
    origins: predictions.length,
    horizonDays,
    ruinThreshold,
    trainWindow,
    pathsPerOrigin,
    brierScore,
    climatologyBrier,
    brierSkillScore:
      climatologyBrier > 0 ? 1 - brierScore / climatologyBrier : 0,
    meanPredicted,
    observedRate,
    bias: meanPredicted - observedRate,
    effectiveSampleSize,
    bins,
    notes,
  };
}

/**
 * Replay the *actual* returns from `origin` forward and report whether the book
 * would really have breached the ruin threshold.
 *
 * This mirrors the simulator's liquidation logic exactly (same maintenance
 * margin, same absorbing state on a closed position) because a calibration
 * test where forecast and outcome use different accounting measures nothing.
 */
export function realisedRuin(
  positions: PricedPosition[],
  returnMatrix: number[][],
  origin: number,
  horizonDays: number,
  ruinThreshold: number,
): boolean {
  const startingEquity = positions.reduce((acc, p) => acc + p.equity, 0);
  if (startingEquity <= 0) return false;

  const prices = positions.map((p) => p.price);
  const alive = positions.map(() => true);
  const mmrs = positions.map(
    (p) => p.maintenanceMarginRate ?? defaultMaintenance(p.leverage),
  );

  const last = Math.min(origin + horizonDays, returnMatrix[0]?.length ?? 0);

  for (let t = origin; t < last; t++) {
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

    if (equity / startingEquity <= 1 - ruinThreshold) return true;
  }

  return false;
}

/** Local copy of the venue-tier maintenance schedule, kept in sync with cascade.ts. */
function defaultMaintenance(leverage: number): number {
  if (leverage >= 50) return 0.004;
  if (leverage >= 20) return 0.005;
  if (leverage >= 10) return 0.0075;
  if (leverage >= 5) return 0.01;
  if (leverage > 1) return 0.02;
  return 0;
}

/* ------------------------------------------------------------------ */
/* Combined report                                                     */
/* ------------------------------------------------------------------ */

export interface BacktestReport {
  generatedAt: number;
  lookbackDays: number;
  trainWindow: number;
  var95: VarExceptionTest[];
  var99: VarExceptionTest[];
  calibration: SurvivalCalibration | null;
  /** The estimator whose conditional-coverage test is least rejected at 95%. */
  bestEstimator: VarEstimator | null;
  summary: string;
}

export function runBacktest(
  positions: PricedPosition[],
  returnMatrix: number[][],
  options: {
    trainWindow?: number;
    horizonDays?: number;
    ruinThreshold?: number;
    pathsPerOrigin?: number;
    stride?: number;
  } = {},
): BacktestReport {
  const trainWindow = options.trainWindow ?? 120;
  const nDays = returnMatrix[0]?.length ?? 0;

  const var95 = backtestVar(positions, returnMatrix, {
    confidence: 0.95,
    trainWindow,
  });
  const var99 = backtestVar(positions, returnMatrix, {
    confidence: 0.99,
    trainWindow,
  });

  const calibration = calibrateSurvival(positions, returnMatrix, {
    trainWindow,
    horizonDays: options.horizonDays ?? 30,
    ruinThreshold: options.ruinThreshold ?? 0.5,
    pathsPerOrigin: options.pathsPerOrigin ?? 400,
    stride: options.stride ?? 3,
  });

  const scored = var95.filter((t) => t.observations > 0);
  const bestEstimator =
    scored.length > 0
      ? scored.reduce((a, b) =>
          b.conditionalCoverageP > a.conditionalCoverageP ? b : a,
        ).estimator
      : null;

  let summary: string;
  if (scored.length === 0) {
    summary = `Not enough history to backtest: ${nDays} days available, at least ${
      trainWindow + 11
    } needed.`;
  } else {
    const passing = scored.filter((t) => t.verdict === "pass");
    const names: Record<VarEstimator, string> = {
      historical: "historical simulation",
      parametric: "variance-covariance",
      "cornish-fisher": "Cornish-Fisher",
    };
    if (passing.length === 0) {
      summary = `No 95% VaR estimator passed out-of-sample on this book. ${
        names[scored.reduce((a, b) =>
          b.conditionalCoverageP > a.conditionalCoverageP ? b : a,
        ).estimator]
      } came closest. Size positions off the survival simulation rather than off a daily VaR number.`;
    } else {
      summary = `${passing
        .map((t) => names[t.estimator])
        .join(" and ")} passed conditional coverage at 95% over ${
        scored[0].observations
      } out-of-sample days.`;
    }
  }

  return {
    generatedAt: Date.now(),
    lookbackDays: nDays,
    trainWindow,
    var95,
    var99,
    calibration,
    bestEstimator,
    summary,
  };
}
