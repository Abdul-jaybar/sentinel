import { NextResponse } from "next/server";
import { getMarkets } from "@/lib/market/coingecko";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(
    100,
    Math.max(10, Number(url.searchParams.get("limit") ?? 60)),
  );

  const result = await getMarkets(limit);

  return NextResponse.json(result, {
    headers: {
      // Cached at the edge briefly; the in-process cache handles the rest.
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
    },
  });
}
