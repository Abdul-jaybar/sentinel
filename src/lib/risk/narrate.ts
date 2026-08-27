import type { SentinelReport } from "./engine";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) =>
  `$${Math.round(Math.abs(x)).toLocaleString("en-US")}`;

export interface Narrative {
  headline: string;
  paragraphs: string[];
  source: "deterministic" | "claude";
}

/**
 * Deterministic risk narrator.
 *
 * Deliberately not an LLM by default. A risk explanation that changes wording
 * between two identical portfolios is a liability, and the interesting content
 * here is arithmetic the engine already did. This reads the report and states
 * what it found, in the order that matters, with every number traceable to a
 * field in the report.
 *
 * The optional Claude path (see /api/explain) layers conversational follow-up
 * on top of this, rather than replacing it.
 */
export function narrate(report: SentinelReport): Narrative {
  const {
    exposure,
    survival,
    regimes,
    cascade,
    var99,
    contributions,
    prescription,
    benchmarkSymbol,
  } = report;

  const paragraphs: string[] = [];

  // 1. Where the account stands.
  const headline =
    survival.ruinProbability >= 0.3
      ? `This book has a ${pct(survival.ruinProbability)} chance of halving within ${survival.horizonDays} days.`
      : survival.liquidationProbability >= 0.3
        ? `Nothing here is extreme, but a forced close is more likely than not to be the thing that hurts you.`
        : survival.ruinProbability >= 0.1
          ? `Survivable, but the tail is doing real work in this portfolio.`
          : `This portfolio is carrying modest risk relative to its equity.`;

  paragraphs.push(
    `You are running ${usd(exposure.grossExposure)} of gross exposure against ${usd(exposure.equity)} of equity — ${exposure.leverageRatio.toFixed(2)}x account leverage, ${exposure.netExposure >= 0 ? "net long" : "net short"} ${usd(exposure.netExposure)}. Replayed over the last ${report.lookbackDays} days, the one-day 99% VaR is ${usd(var99.historical)}, or ${pct(var99.pctOfEquity)} of the account; on the days that breach it, the average loss is ${usd(var99.expectedShortfall)}.`,
  );

  // 2. The survival result — the headline product output.
  paragraphs.push(
    `Simulating ${survival.paths.toLocaleString()} bootstrapped ${survival.horizonDays}-day paths from the realised joint return history: ${pct(survival.ruinProbability)} of them lose half the account, ${pct(survival.liquidationProbability)} see at least one position force-closed, and the median path finishes at ${pct(survival.medianTerminalEquityPct)} of where it started. The 5th-percentile path finishes at ${pct(survival.curve[survival.curve.length - 1]?.p05 ?? 1)}.${survival.medianDaysToRuin !== null ? ` Among the paths that do break, the median one breaks on day ${Math.round(survival.medianDaysToRuin)}.` : ""}`,
  );

  // 3. The regime finding.
  if (regimes.symbols.length >= 2 && regimes.stressedDays > 0) {
    paragraphs.push(
      `Correlation is not stable across regimes here. On the ${regimes.calmDays} lowest-volatility ${benchmarkSymbol} days your positions averaged ${regimes.avgCalm.toFixed(2)} pairwise correlation; on the ${regimes.stressedDays} highest-volatility days they averaged ${regimes.avgStressed.toFixed(2)}. In effective-bet terms that is ${regimes.effectiveBetsCalm.toFixed(1)} independent bets in calm markets and ${regimes.effectiveBetsStressed.toFixed(1)} in stressed ones${regimes.worstPair ? `, with ${regimes.worstPair.a} and ${regimes.worstPair.b} converging hardest (${regimes.worstPair.calm.toFixed(2)} → ${regimes.worstPair.stressed.toFixed(2)})` : ""}. ${regimes.decay > 0.15 ? "The diversification you are being paid for in quiet markets is not there in the sell-off you are actually sized against." : "That decay is mild — the book keeps most of its diversification when it matters."}`,
    );
  }

  // 4. The cascade.
  if (cascade.hasLeverage && cascade.firstLiquidationMove !== null) {
    const clusters = cascade.points
      .slice(0, 3)
      .map(
        (p) =>
          `${pct(p.benchmarkMove)} → ${p.symbols.join(" + ")} (equity left: ${pct(p.equityPctAfter)})`,
      )
      .join("; ");
    paragraphs.push(
      `Liquidation ladder against ${benchmarkSymbol}: ${clusters}.${cascade.largestSimultaneousLiquidation >= 2 ? ` ${cascade.largestSimultaneousLiquidation} positions die inside the same move, which is the failure mode per-position liquidation prices hide — they are computed one at a time and never show you the cluster.` : ""}${cascade.wipeoutMove !== null ? ` The account is fully gone at ${pct(cascade.wipeoutMove)}.` : ""}`,
    );
  }

  // 5. Where the tail risk actually sits.
  const top = contributions[0];
  if (top) {
    const mismatch = top.esShare - top.exposureShare;
    paragraphs.push(
      `Tail risk is concentrated in ${top.symbol}: ${pct(top.exposureShare)} of gross exposure but ${pct(top.esShare)} of expected shortfall${Math.abs(mismatch) > 0.08 ? `, a ${mismatch > 0 ? "larger" : "smaller"} share than its size suggests` : ""}. Its beta to ${benchmarkSymbol} is ${top.beta.toFixed(2)} and its annualised volatility is ${pct(top.volatility)}.`,
    );
  }

  // 6. What to do about it.
  if (prescription.actions.length > 0) {
    const best = prescription.actions[0];
    const others = prescription.actions
      .slice(1, 3)
      .map(
        (a) =>
          `${a.label} (${pct(a.ruinReduction)} off ruin probability)`,
      )
      .join(", ");
    paragraphs.push(
      `The cheapest meaningful fix is: ${best.label}. ${best.detail} That moves ruin probability from ${pct(prescription.baselineRuinProbability)} to ${pct(best.ruinProbabilityAfter)} — ${pct(best.ruinReduction)} removed${best.exposureClosed > 0 ? ` for ${usd(best.exposureClosed)} of exposure given up` : ` for ${usd(best.capitalRequired)} of additional margin`}.${others ? ` Runners-up: ${others}.` : ""}`,
    );
  } else {
    paragraphs.push(
      `No single de-risking action moves ruin probability by more than half a point, which usually means the risk is spread evenly rather than sitting in one position. Reducing overall size is the lever, not reshuffling between assets.`,
    );
  }

  return { headline, paragraphs, source: "deterministic" };
}

/**
 * Compact JSON view of the report, used as grounding context when the optional
 * Claude co-pilot is enabled. Sending the full report would blow the context
 * budget and bury the signal; this is the subset a risk conversation needs.
 */
export function narrationContext(report: SentinelReport) {
  return {
    equity: report.exposure.equity,
    grossExposure: report.exposure.grossExposure,
    netExposure: report.exposure.netExposure,
    accountLeverage: report.exposure.leverageRatio,
    lookbackDays: report.lookbackDays,
    dataSource: report.dataSource,
    positions: report.positions.map((p) => ({
      symbol: p.symbol,
      quantity: p.quantity,
      leverage: p.leverage,
      notional: p.notional,
      unrealizedPnl: p.unrealizedPnl,
    })),
    var99: report.var99,
    survival: {
      horizonDays: report.survival.horizonDays,
      ruinThreshold: report.survival.ruinThreshold,
      ruinProbability: report.survival.ruinProbability,
      liquidationProbability: report.survival.liquidationProbability,
      medianTerminalEquityPct: report.survival.medianTerminalEquityPct,
      paths: report.survival.paths,
    },
    regimes: {
      avgCalm: report.regimes.avgCalm,
      avgStressed: report.regimes.avgStressed,
      decay: report.regimes.decay,
      effectiveBetsCalm: report.regimes.effectiveBetsCalm,
      effectiveBetsStressed: report.regimes.effectiveBetsStressed,
      worstPair: report.regimes.worstPair,
    },
    cascade: {
      firstLiquidationMove: report.cascade.firstLiquidationMove,
      wipeoutMove: report.cascade.wipeoutMove,
      points: report.cascade.points.slice(0, 5),
    },
    contributions: report.contributions.map((c) => ({
      symbol: c.symbol,
      exposureShare: c.exposureShare,
      esShare: c.esShare,
      beta: c.beta,
      volatility: c.volatility,
    })),
    stress: report.stress.map((s) => ({
      name: s.name,
      equityChangePct: s.equityChangePct,
      liquidated: s.liquidated,
    })),
    prescription: report.prescription.actions,
    alerts: report.alerts.map((a) => ({
      severity: a.severity,
      title: a.title,
    })),
  };
}
