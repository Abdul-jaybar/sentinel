import { NextResponse } from "next/server";
import { getHistory, getMarkets } from "@/lib/market/coingecko";
import { datasetInfo } from "@/lib/market/dataset";
import { runBacktest } from "@/lib/risk/backtest";
import { pricePositions } from "@/lib/risk/engine";
import { alignSeries } from "@/lib/risk/returns";
import { backtestRequestSchema } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Walk-forward validation re-runs the simulation at every origin.
export const maxDuration = 120;

/**
 * Out-of-sample validation.
 *
 * Split from /api/risk on purpose. The dashboard should stay fast, and this is
 * the expensive call: a full Monte Carlo at every walk-forward origin plus a
 * rolling re-estimation of three VaR models. Separating them also makes the
 * honest thing easy: the validation is something you ask for and read, not a
 * number that flashes past in a summary bar.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = backtestRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid request.",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const {
    positions,
    lookbackDays,
    trainWindow,
    horizonDays,
    ruinThreshold,
    benchmarkCoinId,
  } = parsed.data;

  const coinIds = [
    ...new Set([...positions.map((p) => p.coinId), benchmarkCoinId]),
  ];

  const started = Date.now();

  try {
    const [history, markets] = await Promise.all([
      getHistory(coinIds, lookbackDays),
      getMarkets(100),
    ]);

    const livePrices: Record<string, number> = {};
    for (const m of markets.data) livePrices[m.coinId] = m.price;
    for (const s of history.data) {
      if (livePrices[s.coinId] === undefined) {
        livePrices[s.coinId] = s.prices[s.prices.length - 1] ?? 0;
      }
    }

    const aligned = alignSeries(history.data);
    const priced = pricePositions(positions, livePrices).filter(
      (p) => aligned.returns[p.coinId] !== undefined,
    );

    if (priced.length === 0) {
      return NextResponse.json(
        { error: "None of the supplied positions had usable price history." },
        { status: 422 },
      );
    }

    const returnMatrix = priced.map((p) => aligned.returns[p.coinId] ?? []);
    const available = aligned.timestamps.length;

    if (available <= trainWindow + 10) {
      return NextResponse.json(
        {
          error: "Not enough history to validate.",
          detail: `${available} aligned days available; a ${trainWindow}-day training window needs at least ${
            trainWindow + 11
          } to score even ten out-of-sample days. Run \`npm run fetch:history\` to extend the committed dataset, or lower the training window.`,
          available,
          required: trainWindow + 11,
          dataset: datasetInfo(),
        },
        { status: 422 },
      );
    }

    const report = runBacktest(priced, returnMatrix, {
      trainWindow,
      horizonDays,
      ruinThreshold,
    });

    return NextResponse.json({
      backtest: report,
      dataSource: history.source,
      dataset: datasetInfo(),
      notice: history.notice,
      computeMs: Date.now() - started,
    });
  } catch (error) {
    console.error("[backtest] failed", error);
    return NextResponse.json(
      { error: "Validation run failed. Please retry." },
      { status: 500 },
    );
  }
}
