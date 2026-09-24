"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, CodeXml, RefreshCw, ShieldAlert } from "lucide-react";
import type { MarketAsset, Position } from "@/lib/types";
import type { SentinelReport } from "@/lib/risk/engine";
import type { Narrative } from "@/lib/risk/narrate";
import { PRESETS, instantiate } from "@/lib/presets";
import { num, pct, usd } from "@/lib/format";
import { Badge, Button, Card, Caveat, Stat } from "@/components/ui";
import { PositionEditor } from "@/components/PositionEditor";
import {
  CascadeChart,
  ContributionChart,
  DistributionChart,
  DrawdownChart,
  RegimeHeatmaps,
  SurvivalChart,
} from "@/components/charts";
import {
  AlertFeed,
  LiquidationTable,
  NarrativePanel,
  PrescriptionPanel,
  StressTable,
} from "@/components/panels";
import { ValidationPanel } from "@/components/ValidationPanel";

const STORAGE_KEY = "sentinel.positions.v1";

interface RiskResponse {
  report: SentinelReport;
  narrative: Narrative;
  notice?: string;
  computeMs: number;
}

export default function Home() {
  const [markets, setMarkets] = useState<MarketAsset[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [horizonDays, setHorizonDays] = useState(30);
  const [ruinThreshold, setRuinThreshold] = useState(0.5);
  const [lookbackDays, setLookbackDays] = useState(90);

  const [result, setResult] = useState<RiskResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestId = useRef(0);

  // --- Bootstrap ------------------------------------------------------
  useEffect(() => {
    let restored: Position[] | null = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) restored = JSON.parse(raw) as Position[];
    } catch {
      // Private-browsing or blocked storage: fall through to the preset.
    }
    setPositions(
      restored && restored.length > 0 ? restored : instantiate(PRESETS[0]),
    );

    fetch("/api/markets?limit=80")
      .then((r) => r.json())
      .then((d) => setMarkets(d.data ?? []))
      .catch(() => setMarkets([]));
  }, []);

  useEffect(() => {
    if (positions.length === 0) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
    } catch {
      // Non-fatal: the app works fine without persistence.
    }
  }, [positions]);

  // --- Compute --------------------------------------------------------
  const run = useCallback(async () => {
    if (positions.length === 0) {
      setResult(null);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/risk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          positions,
          horizonDays,
          ruinThreshold,
          lookbackDays,
          paths: 2000,
        }),
      });
      const data = await res.json();
      if (id !== requestId.current) return; // a newer request already won
      if (!res.ok) {
        setError(data.error ?? "Risk computation failed.");
        return;
      }
      setResult(data as RiskResponse);
    } catch {
      if (id === requestId.current) setError("Could not reach the risk engine.");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [positions, horizonDays, ruinThreshold, lookbackDays]);

  // Debounced auto-run: typing a quantity should not fire a simulation per
  // keystroke, but the user should never have to press a button either.
  useEffect(() => {
    const t = setTimeout(run, 600);
    return () => clearTimeout(t);
  }, [run]);

  const report = result?.report;

  const verdictTone = useMemo(() => {
    if (!report) return "neutral" as const;
    const p = report.survival.ruinProbability;
    if (p >= 0.35) return "crit" as const;
    if (p >= 0.15) return "warn" as const;
    return "safe" as const;
  }, [report]);

  return (
    <main className="grid-bg min-h-screen">
      <div className="mx-auto max-w-[1400px] px-5 py-8 lg:px-8">
        {/* ---------------- Header ---------------- */}
        <header className="mb-8 flex flex-wrap items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-signal-accent/40 bg-signal-accent/10">
                <ShieldAlert className="h-4.5 w-4.5 text-signal-accent" />
              </div>
              <div>
                <h1 className="text-[22px] leading-tight font-semibold tracking-tight text-ink-100">
                  Sentinel
                </h1>
                <p className="text-[12px] text-ink-400">
                  Survival analysis for leveraged crypto portfolios
                </p>
              </div>
            </div>
            <p className="mt-4 max-w-2xl text-[13.5px] leading-relaxed text-ink-300">
              Leveraged books rarely die because one position moved. They die
              because six positions that looked independent moved together and
              hit their maintenance levels inside the same hour. Sentinel
              measures that specific failure: it splits your correlations into
              calm and stressed regimes, bootstraps thousands of forward paths
              from the joint return history, walks the benchmark down to find
              where positions liquidate <em>simultaneously</em>, and then ranks
              the cheapest action that meaningfully reduces the chance of ruin.
            </p>
          </div>

          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              {report && (
                <Badge tone={report.dataSource === "live" ? "safe" : "warn"}>
                  <span
                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                      report.dataSource === "live"
                        ? "pulse-dot bg-signal-safe"
                        : "bg-signal-warn"
                    }`}
                  />
                  {report.dataSource === "live"
                    ? "live market data"
                    : "reference dataset"}
                </Badge>
              )}
              <Button onClick={run} disabled={loading}>
                <RefreshCw
                  className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                />
                {loading ? "Simulating" : "Re-run"}
              </Button>
            </div>
            {result && (
              <div className="text-[11px] text-ink-500">
                {report?.survival.paths.toLocaleString()} paths ·{" "}
                {report?.lookbackDays}d lookback · {result.computeMs}ms
              </div>
            )}
          </div>
        </header>

        {/* ---------------- Notices ---------------- */}
        {result?.notice && (
          <div className="mb-6 rounded-lg border border-signal-warn/30 bg-signal-warn/5 px-4 py-3 text-[12.5px] text-signal-warn">
            {result.notice}
          </div>
        )}
        {error && (
          <div className="mb-6 rounded-lg border border-signal-crit/30 bg-signal-crit/5 px-4 py-3 text-[12.5px] text-signal-crit">
            {error}
          </div>
        )}
        {report && report.droppedAssets.length > 0 && (
          <div className="mb-6 rounded-lg border border-ink-600 bg-ink-850/50 px-4 py-3 text-[12.5px] text-ink-400">
            Excluded from the covariance estimate for insufficient overlapping
            history: {report.droppedAssets.join(", ")}.
          </div>
        )}

        {/* ---------------- Verdict ---------------- */}
        {report && (
          <div className="mb-6 grid gap-4 rounded-xl border border-ink-700/70 bg-ink-900/60 p-5 sm:grid-cols-2 lg:grid-cols-5">
            <Stat
              label={`P(lose ${pct(ruinThreshold, 0)} in ${horizonDays}d)`}
              value={pct(report.survival.ruinProbability)}
              tone={verdictTone}
              size="lg"
              sub={
                report.survival.medianDaysToRuin !== null
                  ? `median break on day ${Math.round(report.survival.medianDaysToRuin)}`
                  : "no path breached the threshold"
              }
            />
            <Stat
              label="P(any liquidation)"
              value={pct(report.survival.liquidationProbability)}
              tone={
                report.survival.liquidationProbability >= 0.4
                  ? "crit"
                  : report.survival.liquidationProbability >= 0.2
                    ? "warn"
                    : "safe"
              }
              size="lg"
              sub={`${pct(report.survival.totalWipeoutProbability)} lose the whole book`}
            />
            <Stat
              label="Independent bets (stressed)"
              value={num(report.regimes.effectiveBetsStressed, 2)}
              tone={
                report.regimes.effectiveBetsStressed < 1.6 &&
                report.positions.length >= 3
                  ? "warn"
                  : "neutral"
              }
              size="lg"
              sub={`${report.positions.length} positions · ${num(report.regimes.effectiveBetsCalm, 2)} when calm`}
            />
            <Stat
              label="Account leverage"
              value={`${num(report.exposure.leverageRatio, 2)}x`}
              tone={
                report.exposure.leverageRatio >= 5
                  ? "crit"
                  : report.exposure.leverageRatio >= 3
                    ? "warn"
                    : "neutral"
              }
              size="lg"
              sub={`${usd(report.exposure.grossExposure, { compact: true })} gross on ${usd(report.exposure.equity, { compact: true })} equity`}
            />
            <Stat
              label="1-day 99% VaR"
              value={usd(report.var99.historical, { compact: true })}
              tone={report.var99.pctOfEquity >= 0.15 ? "crit" : "neutral"}
              size="lg"
              sub={`${pct(report.var99.pctOfEquity)} of equity · ES ${usd(report.var99.expectedShortfall, { compact: true })}`}
            />
          </div>
        )}

        {/* ---------------- Portfolio ---------------- */}
        <Card
          title="Portfolio"
          subtitle="Signed quantities: negative means short. Everything recomputes automatically."
          className="mb-6"
        >
          <PositionEditor
            positions={positions}
            markets={markets}
            onChange={setPositions}
          />

          <div className="mt-5 flex flex-wrap items-end gap-6 border-t border-ink-700/60 pt-4">
            <label className="text-[12px]">
              <span className="mb-1 block tracking-[0.14em] text-ink-400 uppercase">
                Horizon
              </span>
              <select
                value={horizonDays}
                onChange={(e) => setHorizonDays(Number(e.target.value))}
                className="rounded-lg border border-ink-600 bg-ink-900 px-3 py-1.5 text-[13px] text-ink-100 outline-none focus:border-signal-accent/60"
              >
                {[7, 14, 30, 60, 90].map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[12px]">
              <span className="mb-1 block tracking-[0.14em] text-ink-400 uppercase">
                Ruin defined as
              </span>
              <select
                value={ruinThreshold}
                onChange={(e) => setRuinThreshold(Number(e.target.value))}
                className="rounded-lg border border-ink-600 bg-ink-900 px-3 py-1.5 text-[13px] text-ink-100 outline-none focus:border-signal-accent/60"
              >
                {[0.2, 0.3, 0.5, 0.7, 0.9].map((d) => (
                  <option key={d} value={d}>
                    -{Math.round(d * 100)}% drawdown
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[12px]">
              <span className="mb-1 block tracking-[0.14em] text-ink-400 uppercase">
                Lookback
              </span>
              <select
                value={lookbackDays}
                onChange={(e) => setLookbackDays(Number(e.target.value))}
                className="rounded-lg border border-ink-600 bg-ink-900 px-3 py-1.5 text-[13px] text-ink-100 outline-none focus:border-signal-accent/60"
              >
                {[60, 90, 180, 365].map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </select>
            </label>
            <p className="max-w-md text-[11.5px] leading-relaxed text-ink-500">
              A longer lookback gives a more stable covariance estimate but
              blends in market conditions that no longer apply. 90 days is the
              default because it is long enough for a usable stressed-regime
              sample and short enough to still describe the current market.
            </p>
          </div>
        </Card>

        {!report && !error && (
          <div className="rounded-xl border border-ink-700/70 bg-ink-900/40 px-6 py-16 text-center">
            <Activity className="mx-auto mb-3 h-6 w-6 animate-pulse text-ink-500" />
            <p className="text-[13px] text-ink-400">
              Fetching market history and running the simulation…
            </p>
          </div>
        )}

        {report && result && (
          <div className="space-y-6">
            {/* -------- Survival + assessment -------- */}
            <div className="grid gap-6 lg:grid-cols-5">
              <Card
                title="Survival simulation"
                subtitle={`${report.survival.paths.toLocaleString()} block-bootstrap paths · median, 25-75 and 5-95 percentile equity bands · dashed green line is the probability of not yet having breached the ruin threshold`}
                className="lg:col-span-3"
              >
                <SurvivalChart report={report} />
                <Caveat>
                  Paths are built by resampling contiguous blocks of real
                  trading days across all assets at once, so cross-asset
                  dependence and volatility clustering survive intact. The cost
                  of that honesty: the simulation cannot produce a move the
                  market has never produced. Treat the left tail as a floor on
                  the risk, not a ceiling.
                </Caveat>
              </Card>

              <Card
                title="Assessment"
                className="lg:col-span-2"
                aside={
                  <Badge tone={verdictTone === "safe" ? "safe" : verdictTone}>
                    {verdictTone === "crit"
                      ? "high risk"
                      : verdictTone === "warn"
                        ? "elevated"
                        : "contained"}
                  </Badge>
                }
              >
                <NarrativePanel report={report} narrative={result.narrative} />
              </Card>
            </div>

            {/* -------- Prescription -------- */}
            <Card
              title="What to do about it"
              subtitle="Every candidate action re-simulated. Ranked by ruin probability removed per unit of cost, and filtered so the shortlist shows genuinely different choices rather than the same move five times."
            >
              <PrescriptionPanel report={report} />
            </Card>

            {/* -------- Cascade + regimes -------- */}
            <div className="grid gap-6 lg:grid-cols-2">
              <Card
                title="Liquidation cascade"
                subtitle={`Account equity as ${report.benchmarkSymbol} falls, with each asset moving by its own beta. Red dots mark the moves where positions are force-closed.`}
              >
                <CascadeChart report={report} />
                <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-[12px] text-ink-400">
                  <span>
                    First liquidation{" "}
                    <span className="tnum text-signal-warn">
                      {report.cascade.firstLiquidationMove !== null
                        ? pct(report.cascade.firstLiquidationMove)
                        : "-"}
                    </span>
                  </span>
                  <span>
                    Largest simultaneous cluster{" "}
                    <span className="tnum text-signal-crit">
                      {report.cascade.largestSimultaneousLiquidation}
                    </span>
                  </span>
                  <span>
                    Account wiped out at{" "}
                    <span className="tnum text-signal-crit">
                      {report.cascade.wipeoutMove !== null
                        ? pct(report.cascade.wipeoutMove)
                        : "beyond -60%"}
                    </span>
                  </span>
                </div>
              </Card>

              <Card
                title="Correlation regimes"
                subtitle={`Correlation measured separately in ${report.benchmarkSymbol}'s low-volatility and high-volatility regimes`}
                aside={
                  <Badge
                    tone={
                      report.regimes.decay >= 0.3
                        ? "crit"
                        : report.regimes.decay >= 0.15
                          ? "warn"
                          : "safe"
                    }
                  >
                    decay {report.regimes.decay >= 0 ? "+" : ""}
                    {report.regimes.decay.toFixed(2)}
                  </Badge>
                }
              >
                <RegimeHeatmaps report={report} />
                <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2">
                  <Stat
                    label="Avg corr · calm"
                    value={num(report.regimes.avgCalm, 2)}
                    size="sm"
                  />
                  <Stat
                    label="Avg corr · stressed"
                    value={num(report.regimes.avgStressed, 2)}
                    size="sm"
                    tone={report.regimes.avgStressed > 0.75 ? "crit" : "neutral"}
                  />
                  <Stat
                    label="Bets · calm"
                    value={num(report.regimes.effectiveBetsCalm, 2)}
                    size="sm"
                  />
                  <Stat
                    label="Bets · stressed"
                    value={num(report.regimes.effectiveBetsStressed, 2)}
                    size="sm"
                    tone={
                      report.regimes.effectiveBetsStressed < 1.6
                        ? "warn"
                        : "neutral"
                    }
                  />
                </div>
                <Caveat>
                  Effective bets is the exponential Shannon entropy of the
                  correlation matrix&apos;s eigenvalue spectrum: how many
                  genuinely independent risks the book holds, as opposed to how
                  many tickers are in it.
                </Caveat>
              </Card>
            </div>

            {/* -------- Alerts -------- */}
            <Card
              title="Findings"
              subtitle="Every alert states the measured value and the threshold it crossed, so it can be argued with"
            >
              <AlertFeed report={report} />
            </Card>

            {/* -------- Attribution -------- */}
            <div className="grid gap-6 lg:grid-cols-2">
              <Card
                title="Where the tail risk sits"
                subtitle="Share of gross exposure (grey) against share of expected shortfall (blue/red). A red bar means that asset does more damage than its size implies."
              >
                <ContributionChart report={report} />
                <Caveat>
                  Expected shortfall splits exactly across positions by Euler
                  decomposition, so each asset is charged with how it actually
                  behaved on the days the whole book was losing, not with how
                  volatile it is in isolation.
                </Caveat>
              </Card>

              <Card
                title="Loss distribution"
                subtitle={`Daily P&L of today's book replayed over ${report.lookbackDays} days of history`}
              >
                <DistributionChart report={report} />
                <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Stat
                    label="VaR 95 (hist)"
                    value={usd(report.var95.historical, { compact: true })}
                    size="sm"
                  />
                  <Stat
                    label="VaR 99 (hist)"
                    value={usd(report.var99.historical, { compact: true })}
                    size="sm"
                  />
                  <Stat
                    label="VaR 99 (normal)"
                    value={usd(report.var99.parametric, { compact: true })}
                    size="sm"
                  />
                  <Stat
                    label="VaR 99 (C-F)"
                    value={usd(report.var99.cornishFisher, { compact: true })}
                    size="sm"
                  />
                </div>
                <Caveat>
                  Three estimators, shown together on purpose. When the
                  historical figure sits well above the normal-distribution one,
                  the risk lives in a handful of specific days rather than in
                  day-to-day volatility, and a model that only knows about
                  volatility will under-size it. Cornish-Fisher corrects the
                  normal estimate for skew and fat tails.
                </Caveat>
              </Card>
            </div>

            {/* -------- Validation -------- */}
            <ValidationPanel positions={positions} />

            {/* -------- Stress + liquidation -------- */}
            <Card
              title="Historical stress scenarios"
              subtitle={
                report.dataQuality.measuredScenarios > 0
                  ? `${report.dataQuality.measuredScenarios} of ${report.dataQuality.totalScenarios} measured from real data for these assets; the rest are modelled`
                  : "Modelled: a benchmark move propagated to each asset by its beta. Run `npm run fetch:history` to replace these with what actually happened."
              }
            >
              <StressTable report={report} />
            </Card>

            <div className="grid gap-6 lg:grid-cols-2">
              <Card
                title="Liquidation proximity"
                subtitle="Per-position, with the probability of touching the level at any point in the horizon"
              >
                <LiquidationTable report={report} />
              </Card>

              <Card
                title="Drawdown back-cast"
                subtitle={`How today's positions would have drawn down over the last ${report.lookbackDays} days`}
              >
                <DrawdownChart report={report} />
                <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Stat
                    label="Max drawdown"
                    value={pct(report.performance.maxDrawdown)}
                    size="sm"
                    tone="crit"
                  />
                  <Stat
                    label="Ann. volatility"
                    value={pct(report.performance.annualisedVolatility, 0)}
                    size="sm"
                  />
                  <Stat
                    label="Sharpe"
                    value={num(report.performance.sharpe, 2)}
                    size="sm"
                  />
                  <Stat
                    label={`Beta to ${report.benchmarkSymbol}`}
                    value={num(report.performance.beta, 2)}
                    size="sm"
                  />
                </div>
                {report.performance.backcastRuined && (
                  <p className="mt-3 rounded-lg border border-signal-crit/40 bg-signal-crit/10 px-3 py-2 text-[12px] leading-relaxed text-signal-crit">
                    This book would not have survived the lookback window. The
                    curve stops at the day equity reached zero. An account that
                    is closed cannot participate in the recovery, so nothing is
                    drawn after that point.
                  </p>
                )}
                <Caveat>
                  This is a back-cast of the current book, not a track record.
                  It answers &ldquo;what would today&apos;s positions have
                  done&rdquo;, which is the only honest drawdown figure for a
                  portfolio that was just entered. Quantities are held constant
                  and positions are revalued daily, so exposure shrinks as prices
                  fall. Holding <em>dollar</em> exposure constant instead would
                  silently model re-levering into every drawdown.
                </Caveat>
              </Card>
            </div>

            {/* -------- Footer -------- */}
            <footer className="border-t border-ink-700/60 pt-6 pb-4">
              <div className="flex flex-wrap items-start justify-between gap-6">
                <div className="max-w-2xl">
                  <h3 className="mb-2 text-[11px] tracking-[0.16em] text-ink-400 uppercase">
                    What this model cannot see
                  </h3>
                  <p className="text-[12.5px] leading-relaxed text-ink-400">
                    Sentinel is built on {report.lookbackDays} days of daily
                    closes and a bootstrap of those same days. It has no view on
                    venue insolvency, stablecoin depegs, oracle failure, funding
                    costs, slippage during a cascade, or any move larger than
                    the largest one in its sample. Intraday liquidation risk is
                    understated because the model steps one day at a time.
                    Treat every number here as a lower bound on how bad things
                    can get, and as a tool for comparing portfolios against each
                    other rather than as a forecast. Nothing here is investment
                    advice.
                  </p>
                </div>
                <a
                  href="https://github.com"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg border border-ink-600 px-3 py-1.5 text-[12.5px] text-ink-400 transition-colors hover:border-ink-500 hover:text-ink-200"
                >
                  <CodeXml className="h-3.5 w-3.5" />
                  Source
                </a>
              </div>
            </footer>
          </div>
        )}
      </div>
    </main>
  );
}
