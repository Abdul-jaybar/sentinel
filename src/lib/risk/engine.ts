import type {
  Position,
  PriceSeries,
  PricedPosition,
  RiskReport,
} from "@/lib/types";
import { buildAlerts } from "./alerts";
import { buildCascade, defaultMaintenanceMarginRate, type CascadeReport } from "./cascade";
import { correlationMatrix, covarianceMatrix } from "./matrix";
import {
  computeConcentration,
  computeLiquidationRisk,
  computePerformance,
  drawdownSeries,
} from "./performance";
import { prescribeActions, type PrescriptionReport } from "./prescribe";
import { correlationRegimes, type RegimeCorrelation } from "./regime";
import { alignSeries, portfolioPnlSeries } from "./returns";
import { runStressTests } from "./stress";
import { beta as olsBeta, stdev, TRADING_DAYS_PER_YEAR } from "./stats";
import { simulateSurvival, type SurvivalReport } from "./survival";
import {
  componentExpectedShortfall,
  computeVar,
  pnlHistogram,
} from "./var";

export interface SentinelReport extends RiskReport {
  regimes: RegimeCorrelation;
  survival: SurvivalReport;
  cascade: CascadeReport;
  prescription: PrescriptionReport;
  /** Assets dropped for insufficient overlapping history. */
  droppedAssets: string[];
}

export interface EngineOptions {
  benchmarkCoinId?: string;
  horizonDays?: number;
  ruinThreshold?: number;
  paths?: number;
  /** Skip the (expensive) prescription search — used by the preview endpoint. */
  skipPrescription?: boolean;
}

/** Attach live prices and derive exposure figures for each raw position. */
export function pricePositions(
  positions: Position[],
  prices: Record<string, number>,
): PricedPosition[] {
  const priced = positions
    .filter((p) => Math.abs(p.quantity) > 0 && p.leverage >= 1)
    .map((p) => {
      const price = prices[p.coinId] ?? p.entryPrice;
      const notional = p.quantity * price;
      const initialMargin = Math.abs(p.quantity * p.entryPrice) / p.leverage;
      const unrealizedPnl = p.quantity * (price - p.entryPrice);
      return {
        ...p,
        maintenanceMarginRate:
          p.maintenanceMarginRate ?? defaultMaintenanceMarginRate(p.leverage),
        price,
        notional,
        initialMargin,
        unrealizedPnl,
        equity: initialMargin + unrealizedPnl,
        weight: 0,
      } satisfies PricedPosition;
    });

  const gross = priced.reduce((acc, p) => acc + Math.abs(p.notional), 0) || 1;
  for (const p of priced) p.weight = Math.abs(p.notional) / gross;
  return priced;
}

/**
 * The orchestrator.
 *
 * Order matters here: series alignment happens first because every downstream
 * number depends on the assets sharing a date axis, and the regime split is
 * computed from the benchmark's own returns so that the definition of "stress"
 * does not depend on the portfolio being measured.
 */
export function buildReport(
  positions: Position[],
  series: PriceSeries[],
  livePrices: Record<string, number>,
  dataSource: "live" | "fallback",
  options: EngineOptions = {},
): SentinelReport {
  const benchmarkCoinId = options.benchmarkCoinId ?? "bitcoin";
  const horizonDays = options.horizonDays ?? 30;
  const ruinThreshold = options.ruinThreshold ?? 0.5;

  const aligned = alignSeries(series);
  const priced = pricePositions(positions, livePrices).filter(
    (p) => aligned.returns[p.coinId] !== undefined,
  );

  const symbols = priced.map((p) => p.symbol);
  const coinIds = priced.map((p) => p.coinId);
  const notionals = priced.map((p) => p.notional);
  const returnMatrix = coinIds.map((id) => aligned.returns[id] ?? []);

  const benchmarkReturns =
    aligned.returns[benchmarkCoinId] ??
    returnMatrix[0] ??
    [];

  const benchmarkSeries = series.find((s) => s.coinId === benchmarkCoinId);
  const benchmarkSymbol = benchmarkSeries?.symbol ?? "BTC";

  const equity = priced.reduce((acc, p) => acc + p.equity, 0);
  const grossExposure = priced.reduce((acc, p) => acc + Math.abs(p.notional), 0);
  const netExposure = priced.reduce((acc, p) => acc + p.notional, 0);
  const longExposure = priced
    .filter((p) => p.notional > 0)
    .reduce((acc, p) => acc + p.notional, 0);
  const shortExposure = priced
    .filter((p) => p.notional < 0)
    .reduce((acc, p) => acc + Math.abs(p.notional), 0);

  const exposure = {
    equity,
    grossExposure,
    netExposure,
    longExposure,
    shortExposure,
    leverageRatio: equity > 0 ? grossExposure / equity : 0,
    unrealizedPnl: priced.reduce((acc, p) => acc + p.unrealizedPnl, 0),
  };

  const pnlSeries = portfolioPnlSeries(notionals, returnMatrix);
  const portfolioReturns =
    equity > 0 ? pnlSeries.map((p) => p / equity) : pnlSeries.map(() => 0);

  const covMatrix = covarianceMatrix(returnMatrix);
  const corrMatrix = correlationMatrix(returnMatrix);

  const volatilities = returnMatrix.map(
    (r) => stdev(r) * Math.sqrt(TRADING_DAYS_PER_YEAR),
  );
  const dailyVolatility: Record<string, number> = {};
  coinIds.forEach((id, i) => {
    dailyVolatility[id] = stdev(returnMatrix[i]);
  });

  const betas = returnMatrix.map((r) => olsBeta(r, benchmarkReturns));
  const betaMap: Record<string, number> = {};
  coinIds.forEach((id, i) => {
    betaMap[id] = betas[i];
  });

  const var95 = computeVar(pnlSeries, notionals, covMatrix, equity, 0.95);
  const var99 = computeVar(pnlSeries, notionals, covMatrix, equity, 0.99);

  const contributions = componentExpectedShortfall(
    symbols,
    coinIds,
    notionals,
    returnMatrix,
    pnlSeries,
    covMatrix,
    0.95,
    volatilities,
    betas,
  );

  const drawdowns = drawdownSeries(aligned.timestamps, pnlSeries, equity);
  const performance = computePerformance(
    pnlSeries,
    equity,
    portfolioReturns,
    benchmarkReturns,
    drawdowns,
  );
  const concentration = computeConcentration(priced, corrMatrix);

  const regimes = correlationRegimes(
    symbols,
    returnMatrix,
    benchmarkReturns,
    priced.map((p) => p.weight),
  );

  const survival = simulateSurvival(priced, returnMatrix, {
    horizonDays,
    ruinThreshold,
    paths: options.paths ?? 2000,
  });

  const cascade = buildCascade(priced, betaMap, equity);
  const stress = runStressTests(priced, betaMap, equity);
  const liquidation = computeLiquidationRisk(priced, dailyVolatility, horizonDays);

  const coinIndex: Record<string, number> = {};
  coinIds.forEach((id, i) => {
    coinIndex[id] = i;
  });

  const prescription = options.skipPrescription
    ? { baselineRuinProbability: survival.ruinProbability, actions: [], evaluationPaths: 0 }
    : prescribeActions(priced, returnMatrix, coinIndex, {
        horizonDays,
        ruinThreshold,
      });

  const alerts = buildAlerts({
    exposure,
    var95,
    var99,
    concentration,
    contributions,
    regimes,
    survival,
    cascade,
    liquidation,
    stress,
  });

  return {
    generatedAt: Date.now(),
    dataSource,
    dataNotice:
      dataSource === "fallback"
        ? "Live market feed unavailable — showing a bundled reference dataset. Risk figures are computed the same way but the prices are not current."
        : undefined,
    lookbackDays: aligned.timestamps.length,
    benchmarkSymbol,
    positions: priced,
    exposure,
    var95,
    var99,
    performance,
    concentration,
    contributions,
    correlationMatrix: { symbols, matrix: corrMatrix },
    drawdownSeries: drawdowns,
    pnlHistogram: pnlHistogram(pnlSeries),
    stress,
    liquidation,
    alerts,
    historicalPnl: pnlSeries.map((pnl, t) => ({
      timestamp: aligned.timestamps[t + 1] ?? aligned.timestamps[t] ?? 0,
      pnl,
    })),
    regimes,
    survival,
    cascade,
    prescription,
    droppedAssets: aligned.dropped,
  };
}
