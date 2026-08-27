import type {
  Alert,
  ConcentrationBlock,
  ExposureSummary,
  LiquidationRisk,
  RiskContribution,
  StressResult,
  VarBlock,
} from "@/lib/types";
import type { CascadeReport } from "./cascade";
import type { RegimeCorrelation } from "./regime";
import type { SurvivalReport } from "./survival";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) =>
  `$${Math.round(Math.abs(x)).toLocaleString("en-US")}`;

/**
 * Rules are ordered by how much they should change behaviour, not by how
 * alarming they sound. Every alert states the measured value and the threshold
 * it crossed, so it can be argued with rather than merely obeyed — a risk
 * warning that cannot be checked gets ignored after the second time.
 */
export function buildAlerts(input: {
  exposure: ExposureSummary;
  var99: VarBlock;
  var95: VarBlock;
  concentration: ConcentrationBlock;
  contributions: RiskContribution[];
  regimes: RegimeCorrelation;
  survival: SurvivalReport;
  cascade: CascadeReport;
  liquidation: LiquidationRisk[];
  stress: StressResult[];
}): Alert[] {
  const {
    exposure,
    var99,
    concentration,
    contributions,
    regimes,
    survival,
    cascade,
    liquidation,
    stress,
  } = input;

  const alerts: Alert[] = [];

  // --- Survival ------------------------------------------------------
  if (survival.ruinProbability >= 0.2) {
    alerts.push({
      id: "ruin-high",
      rule: "survival.ruin",
      severity: survival.ruinProbability >= 0.35 ? "critical" : "warning",
      title: `${pct(survival.ruinProbability)} chance of losing half the account in ${survival.horizonDays} days`,
      detail: `Across ${survival.paths.toLocaleString()} paths bootstrapped from the realised joint return history, ${pct(survival.ruinProbability)} of them breach a ${pct(survival.ruinThreshold)} drawdown. Median path ends at ${pct(survival.medianTerminalEquityPct)} of starting equity.`,
      value: survival.ruinProbability,
      threshold: 0.2,
    });
  }

  if (survival.liquidationProbability >= 0.25) {
    alerts.push({
      id: "liq-prob",
      rule: "survival.liquidation",
      severity: survival.liquidationProbability >= 0.5 ? "critical" : "warning",
      title: `${pct(survival.liquidationProbability)} chance at least one position is force-closed`,
      detail: `A forced close is path-dependent: it only takes one bad sequence, not a bad month. This is the probability of touching a maintenance level at any point in the next ${survival.horizonDays} days.`,
      value: survival.liquidationProbability,
      threshold: 0.25,
    });
  }

  // --- Correlation regime -------------------------------------------
  if (regimes.decay >= 0.15) {
    alerts.push({
      id: "corr-decay",
      rule: "regime.decay",
      severity: regimes.decay >= 0.3 ? "critical" : "warning",
      title: `Diversification collapses in stress: correlation goes ${regimes.avgCalm.toFixed(2)} → ${regimes.avgStressed.toFixed(2)}`,
      detail: `On the benchmark's ${regimes.calmDays} lowest-volatility days your positions averaged ${regimes.avgCalm.toFixed(2)} pairwise correlation. On its ${regimes.stressedDays} highest-volatility days they averaged ${regimes.avgStressed.toFixed(2)}. Effective independent bets fall from ${regimes.effectiveBetsCalm.toFixed(1)} to ${regimes.effectiveBetsStressed.toFixed(1)}${regimes.worstPair ? `, with ${regimes.worstPair.a}/${regimes.worstPair.b} moving ${regimes.worstPair.calm.toFixed(2)} → ${regimes.worstPair.stressed.toFixed(2)}` : ""}. Position sizing based on the blended number is too large.`,
      value: regimes.decay,
      threshold: 0.15,
    });
  }

  if (regimes.effectiveBetsStressed > 0 && regimes.effectiveBetsStressed < 1.6 && regimes.symbols.length >= 3) {
    alerts.push({
      id: "one-bet",
      rule: "regime.effective-bets",
      severity: "warning",
      title: `${regimes.symbols.length} positions, ${regimes.effectiveBetsStressed.toFixed(1)} independent bets under stress`,
      detail: `The eigenvalue spectrum of the stressed correlation matrix says this book behaves as roughly one directional trade when it matters. Adding another position from the same cluster does not reduce risk.`,
      value: regimes.effectiveBetsStressed,
      threshold: 1.6,
    });
  }

  // --- Cascade -------------------------------------------------------
  if (cascade.largestSimultaneousLiquidation >= 2) {
    const worst = cascade.points.reduce((a, b) =>
      b.symbols.length > a.symbols.length ? b : a,
    );
    alerts.push({
      id: "cascade",
      rule: "cascade.simultaneous",
      severity: "critical",
      title: `${worst.symbols.length} positions liquidate together at ${pct(worst.benchmarkMove)} on the benchmark`,
      detail: `${worst.symbols.join(", ")} all breach maintenance margin within the same move, because their betas push them past their levels at once. Equity remaining after that rung: ${pct(worst.equityPctAfter)} of the starting account.`,
      value: worst.symbols.length,
      threshold: 2,
    });
  } else if (cascade.firstLiquidationMove !== null && cascade.firstLiquidationMove > -0.15) {
    alerts.push({
      id: "close-liq",
      rule: "cascade.first",
      severity: "warning",
      title: `First liquidation at only ${pct(cascade.firstLiquidationMove)} on the benchmark`,
      detail: `Moves of that size are routine rather than exceptional. The book has little room before forced selling starts.`,
      value: cascade.firstLiquidationMove,
      threshold: -0.15,
    });
  }

  // --- Leverage and exposure ----------------------------------------
  if (exposure.leverageRatio >= 3) {
    alerts.push({
      id: "leverage",
      rule: "exposure.leverage",
      severity: exposure.leverageRatio >= 5 ? "critical" : "warning",
      title: `Account leverage is ${exposure.leverageRatio.toFixed(1)}x`,
      detail: `${usd(exposure.grossExposure)} of gross exposure against ${usd(exposure.equity)} of equity. A ${pct(1 / exposure.leverageRatio)} adverse move on the book erases the account before any single position is liquidated.`,
      value: exposure.leverageRatio,
      threshold: 3,
    });
  }

  // --- VaR -----------------------------------------------------------
  if (var99.pctOfEquity >= 0.1) {
    alerts.push({
      id: "var99",
      rule: "var.equity-share",
      severity: var99.pctOfEquity >= 0.2 ? "critical" : "warning",
      title: `1-day 99% VaR is ${pct(var99.pctOfEquity)} of equity`,
      detail: `On roughly one day in a hundred you should expect to lose at least ${usd(var99.historical)}. Expected shortfall — the average loss on those days — is ${usd(var99.expectedShortfall)}.`,
      value: var99.pctOfEquity,
      threshold: 0.1,
    });
  }

  const tailGap =
    var99.parametric > 0 ? var99.historical / var99.parametric : 1;
  if (tailGap >= 1.35) {
    alerts.push({
      id: "fat-tail",
      rule: "var.model-gap",
      severity: "info",
      title: `Realised tail is ${tailGap.toFixed(2)}x the normal-distribution estimate`,
      detail: `Historical VaR (${usd(var99.historical)}) sits well above the variance-covariance estimate (${usd(var99.parametric)}). Volatility alone is understating this book — the risk lives in a few specific days, not in the day-to-day noise.`,
      value: tailGap,
      threshold: 1.35,
    });
  }

  // --- Concentration --------------------------------------------------
  if (concentration.topWeight >= 0.5 && concentration.effectivePositions < 2.5) {
    alerts.push({
      id: "concentration",
      rule: "concentration.hhi",
      severity: "warning",
      title: `${concentration.topSymbol} is ${pct(concentration.topWeight)} of gross exposure`,
      detail: `HHI of ${concentration.hhi.toFixed(2)} — equivalent to ${concentration.effectivePositions.toFixed(1)} equally-weighted positions.`,
      value: concentration.topWeight,
      threshold: 0.5,
    });
  }

  // Tail risk concentrated somewhere other than the biggest position.
  const topES = contributions[0];
  if (topES && topES.esShare > topES.exposureShare + 0.15) {
    alerts.push({
      id: "hidden-tail",
      rule: "contribution.mismatch",
      severity: "warning",
      title: `${topES.symbol} is ${pct(topES.exposureShare)} of exposure but ${pct(topES.esShare)} of tail risk`,
      detail: `On the days the portfolio loses the most, ${topES.symbol} does a disproportionate share of the damage. Sizing by dollars is hiding it; sizing by contribution to expected shortfall is not.`,
      value: topES.esShare,
      threshold: topES.exposureShare + 0.15,
    });
  }

  // --- Liquidation proximity ------------------------------------------
  for (const l of liquidation.slice(0, 3)) {
    if (l.probTouch30d >= 0.25) {
      alerts.push({
        id: `liq-${l.coinId}`,
        rule: "liquidation.touch",
        severity: l.probTouch30d >= 0.5 ? "critical" : "warning",
        title: `${l.symbol} ${l.leverage}x: ${pct(l.probTouch30d)} chance of touching liquidation in ${l.horizonDays} days`,
        detail: `Liquidation at $${l.liquidationPrice.toLocaleString("en-US", { maximumFractionDigits: 4 })}, which is ${pct(l.distancePct)} away from spot. Probability is the chance of touching that level at any point in the window, not just ending below it.`,
        value: l.probTouch30d,
        threshold: 0.25,
      });
    }
  }

  // --- Stress ---------------------------------------------------------
  const worstStress = stress.reduce(
    (a, b) => (b.equityChangePct < a.equityChangePct ? b : a),
    stress[0],
  );
  if (worstStress && worstStress.equityChangePct <= -0.35) {
    alerts.push({
      id: "stress",
      rule: "stress.worst",
      severity: worstStress.equityChangePct <= -0.7 ? "critical" : "warning",
      title: `${worstStress.name} would cost ${pct(Math.abs(worstStress.equityChangePct))} of the account`,
      detail: `${usd(worstStress.pnl)} loss, leaving ${usd(worstStress.equityAfter)}.${worstStress.liquidated.length > 0 ? ` ${worstStress.liquidated.join(", ")} would be force-closed.` : ""}`,
      value: worstStress.equityChangePct,
      threshold: -0.35,
    });
  }

  const order = { critical: 0, warning: 1, info: 2 } as const;
  return alerts.sort((a, b) => order[a.severity] - order[b.severity]);
}
