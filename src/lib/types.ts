/**
 * Core domain types for Sentinel.
 *
 * Conventions used throughout the risk engine:
 *  - `quantity` is SIGNED. Negative quantity = short position.
 *  - `leverage` >= 1. Spot positions use leverage = 1.
 *  - Returns are SIMPLE arithmetic returns (P_t / P_{t-1} - 1), because
 *    portfolio P&L is linear in simple returns for a single period:
 *      pnl_t = sum_i notional_i * r_{i,t}
 *    Log returns are only used where compounding matters (annualisation).
 *  - All monetary values are USD.
 */

export type Venue = "spot" | "perp" | "defi";

/** A single position as entered by the user. */
export interface Position {
  id: string;
  /** CoinGecko coin id, e.g. "bitcoin". Used as the join key for market data. */
  coinId: string;
  symbol: string;
  /** Signed. Negative = short. */
  quantity: number;
  /** Average entry price in USD. */
  entryPrice: number;
  /** 1 = unlevered spot. */
  leverage: number;
  venue: Venue;
  /** Maintenance margin rate for levered venues (e.g. 0.005 = 0.5%). */
  maintenanceMarginRate?: number;
}

/** A position enriched with live market data and derived exposure figures. */
export interface PricedPosition extends Position {
  price: number;
  /** quantity * price. Signed. */
  notional: number;
  /** |quantity * entryPrice| / leverage: capital committed. */
  initialMargin: number;
  /** quantity * (price - entryPrice) */
  unrealizedPnl: number;
  /** initialMargin + unrealizedPnl */
  equity: number;
  /** Fraction of gross exposure. */
  weight: number;
}

/** Daily close series for one asset, aligned to a shared date axis. */
export interface PriceSeries {
  coinId: string;
  symbol: string;
  /** Unix ms timestamps, ascending, one per daily close. */
  timestamps: number[];
  prices: number[];
}

export interface MarketAsset {
  coinId: string;
  symbol: string;
  name: string;
  price: number;
  marketCap: number;
  volume24h: number;
  change24h: number;
  image?: string;
}

export interface ExposureSummary {
  equity: number;
  grossExposure: number;
  netExposure: number;
  longExposure: number;
  shortExposure: number;
  /** grossExposure / equity */
  leverageRatio: number;
  unrealizedPnl: number;
}

export interface VarBlock {
  /** Confidence level, e.g. 0.99 */
  confidence: number;
  /** 1-day VaR in USD (positive number = expected loss). */
  historical: number;
  parametric: number;
  cornishFisher: number;
  /** 1-day Expected Shortfall (CVaR) in USD. */
  expectedShortfall: number;
  /** VaR as a fraction of account equity, using the historical estimate. */
  pctOfEquity: number;
}

export interface RiskContribution {
  coinId: string;
  symbol: string;
  notional: number;
  /** Share of gross exposure. */
  exposureShare: number;
  /** Euler decomposition of Expected Shortfall, in USD. Sums to total ES. */
  componentES: number;
  /** Share of total ES. Can exceed exposure share (concentration of tail risk). */
  esShare: number;
  /** d(sigma_p)/d(notional_i): parametric marginal risk. */
  marginalVar: number;
  /** Annualised volatility of the asset. */
  volatility: number;
  /** Beta versus the benchmark asset (default BTC). */
  beta: number;
}

export interface DrawdownPoint {
  timestamp: number;
  /** Account equity as a multiple of starting equity. Floored at 0. */
  equityIndex: number;
  /** Peak-to-trough, in [-1, 0]. -1 means the account was gone. */
  drawdown: number;
  /** True from the first day the back-cast equity reached zero onward. */
  ruined: boolean;
}

export interface StressResult {
  id: string;
  name: string;
  description: string;
  /** Shock applied to the benchmark, e.g. -0.37 */
  benchmarkShock: number;
  /**
   * "measured": per-asset returns read from the real dataset for this window.
   * "assumed":  a hand-specified benchmark move propagated by beta.
   * Surfaced in the UI so nobody mistakes one for the other.
   */
  provenance: "assumed" | "measured";
  /** Provenance detail: the window measured, or where an assumption came from. */
  sourceNote: string | null;
  /** Portfolio P&L in USD under the scenario. */
  pnl: number;
  /** Equity remaining after the shock. */
  equityAfter: number;
  /** pnl / equity */
  equityChangePct: number;
  /** Symbols that would breach maintenance margin under this scenario. */
  liquidated: string[];
  perAsset: { symbol: string; shock: number; pnl: number }[];
}

export interface LiquidationRisk {
  coinId: string;
  symbol: string;
  leverage: number;
  side: "long" | "short";
  price: number;
  liquidationPrice: number;
  /** Fractional adverse move required to liquidate, e.g. 0.18 = 18%. */
  distancePct: number;
  /** Probability the barrier is touched within `horizonDays`, driftless GBM. */
  probTouch30d: number;
  horizonDays: number;
}

export type AlertSeverity = "critical" | "warning" | "info";

export interface Alert {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  /** Machine-readable rule id so alerts can be de-duplicated / routed. */
  rule: string;
  value: number;
  threshold: number;
}

export interface PerformanceBlock {
  annualisedVolatility: number;
  annualisedReturn: number;
  sharpe: number;
  sortino: number;
  maxDrawdown: number;
  /** Portfolio beta versus the benchmark. */
  beta: number;
  skewness: number;
  excessKurtosis: number;
  /**
   * True when replaying today's book over the lookback window would have taken
   * account equity to zero. When this is set, `maxDrawdown` is -1 and the
   * equity curve after that date is not a forecast of anything.
   */
  backcastRuined: boolean;
  backcastRuinTimestamp: number | null;
}

export interface ConcentrationBlock {
  /** Herfindahl-Hirschman Index on |weights|. 1 = single asset. */
  hhi: number;
  /** 1 / HHI: the number of equally-weighted positions this is equivalent to. */
  effectivePositions: number;
  /** Largest single-asset share of gross exposure. */
  topWeight: number;
  topSymbol: string;
  /** Average pairwise correlation of held assets, exposure-weighted. */
  avgCorrelation: number;
}

export interface RiskReport {
  generatedAt: number;
  /** "live" when every series came from the upstream API. */
  dataSource: "live" | "fallback";
  dataNotice?: string;
  lookbackDays: number;
  benchmarkSymbol: string;
  positions: PricedPosition[];
  exposure: ExposureSummary;
  var95: VarBlock;
  var99: VarBlock;
  performance: PerformanceBlock;
  concentration: ConcentrationBlock;
  contributions: RiskContribution[];
  correlationMatrix: { symbols: string[]; matrix: number[][] };
  drawdownSeries: DrawdownPoint[];
  pnlHistogram: { bin: number; count: number }[];
  stress: StressResult[];
  liquidation: LiquidationRisk[];
  alerts: Alert[];
  /** Simulated portfolio P&L in USD for each historical day in the lookback. */
  historicalPnl: { timestamp: number; pnl: number }[];
}
