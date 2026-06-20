import { NextResponse } from "next/server";
import { buildPolymarketBtcUpDownResearch } from "@/lib/polymarket-btc-updown";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const result = await buildPolymarketBtcUpDownResearch({
      source: body?.source === "api" ? "api" : "local",
      dataset: body?.dataset,
      apiKey: process.env.COINGLASS_API_KEY,
      years: Number(body?.years ?? 0.05),
      interval: String(body?.interval ?? "5m"),
      exchangeList: String(body?.exchangeList ?? "Binance"),
      symbol: String(body?.symbol ?? "BTC"),
      fitK: body?.fitK === "auto" || body?.fitK == null || body?.fitK === ""
        ? null
        : Number(body.fitK),
      maxK: Number(body?.maxK ?? 8),
      hmmIterations: Number(body?.hmmIterations ?? 10),
      selectedFeatures: Array.isArray(body?.selectedFeatures) ? body.selectedFeatures : null,
      marketPages: Number(body?.marketPages ?? 8),
      maxDailyMarkets: Number(body?.maxDailyMarkets ?? 180),
      entryDelayHours: Number(body?.entryDelayHours ?? 1),
      entryMode: body?.entryMode === "fixed" ? "fixed" : "adaptive",
      scanStepMinutes: Number(body?.scanStepMinutes ?? 5),
      minEntryDelayMinutes: Number(body?.minEntryDelayMinutes ?? 5),
      minTimeToResolveMinutes: Number(body?.minTimeToResolveMinutes ?? 5),
      minEdge: Number(body?.minEdge ?? 0.035),
      minStateSamples: Number(body?.minStateSamples ?? 12),
      slippageCents: Number(body?.slippageCents ?? 0.005),
      includeOdds: body?.includeOdds !== false,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err?.message || "Unexpected Polymarket research error.",
      },
      { status: 500 },
    );
  }
}
