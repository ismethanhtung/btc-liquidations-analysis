import { NextResponse } from "next/server";
import {
  buildPhatich4RegimeAnalysis,
  buildPhatich4RegimeAnalysisFromDataset,
  listPhatich4RegimeDatasets,
} from "@/lib/phatich4-regime";

export async function GET() {
  try {
    const allDatasets = listPhatich4RegimeDatasets();
    const datasets = allDatasets.filter(
      (file) => file.includes("binance") || file.includes("5m")
    );
    return NextResponse.json({
      ok: true,
      datasets,
      defaultDataset: datasets[0] || null,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err?.message || "Unexpected error.",
      },
      { status: 500 },
    );
  }
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const source = String(body?.source || "local");
    const apiKey = process.env.COINGLASS_API_KEY;
    const years = Number(body?.years ?? 1);
    const interval = String(body?.interval ?? "5m");
    const exchangeList = String(body?.exchangeList ?? "Binance");
    const symbol = String(body?.symbol ?? "BTCUSDT");
    const maxK = Number(body?.maxK ?? 6);
    const fitK = body?.fitK === "auto" || body?.fitK === undefined || body?.fitK === null || body?.fitK === ""
      ? null
      : Number(body.fitK);
    const hmmIterations = Number(body?.hmmIterations ?? 10);
    const selectedFeatures = Array.isArray(body?.selectedFeatures) ? body.selectedFeatures : null;

    const result = source === "api"
      ? await buildPhatich4RegimeAnalysis({
          apiKey,
          years,
          interval,
          exchangeList,
          symbol,
          maxK,
          fitK,
          hmmIterations,
          selectedFeatures,
        })
      : buildPhatich4RegimeAnalysisFromDataset({
          dataset: body?.dataset,
          maxK,
          fitK,
          hmmIterations,
          selectedFeatures,
        });

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err?.message || "Unexpected error.",
      },
      { status: 500 },
    );
  }
}
