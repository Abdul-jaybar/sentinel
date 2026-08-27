import { NextResponse } from "next/server";
import { getHistory, getMarkets } from "@/lib/market/coingecko";
import { buildReport } from "@/lib/risk/engine";
import { narrate } from "@/lib/risk/narrate";
import { riskRequestSchema } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The Monte Carlo plus the prescription search is the slow part; give it room.
export const maxDuration = 60;

/**
 * The single compute endpoint.
 *
 * Everything quantitative happens server-side. That is a deliberate choice
 * rather than an accident of framework defaults: the simulation is a few
 * million floating-point operations, the upstream API key (when present) must
 * not reach the browser, and keeping the engine on one side of the wire means
 * the numbers in the UI and the numbers in a future API client are produced by
 * the same code path.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = riskRequestSchema.safeParse(body);
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
    horizonDays,
    ruinThreshold,
    lookbackDays,
    paths,
    benchmarkCoinId,
    skipPrescription,
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
    // Any asset missing from the top-100 market snapshot falls back to the
    // last close in its own history rather than to the user's entry price.
    for (const s of history.data) {
      if (livePrices[s.coinId] === undefined) {
        livePrices[s.coinId] = s.prices[s.prices.length - 1] ?? 0;
      }
    }

    const dataSource =
      history.source === "fallback" || markets.source === "fallback"
        ? "fallback"
        : "live";

    const report = buildReport(positions, history.data, livePrices, dataSource, {
      benchmarkCoinId,
      horizonDays,
      ruinThreshold,
      paths,
      skipPrescription,
    });

    if (report.positions.length === 0) {
      return NextResponse.json(
        {
          error:
            "None of the supplied positions had usable price history. Check the CoinGecko ids.",
        },
        { status: 422 },
      );
    }

    return NextResponse.json({
      report,
      narrative: narrate(report),
      notice: history.notice ?? markets.notice,
      computeMs: Date.now() - started,
    });
  } catch (error) {
    console.error("[risk] failed", error);
    return NextResponse.json(
      { error: "Risk computation failed. Please retry." },
      { status: 500 },
    );
  }
}
