import { NextResponse } from "next/server";

function pickRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.liquidations)) return data.liquidations;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.result)) return data.result;
  return [];
}

export async function POST(req) {
  try {
    const base = process.env.HYPERLIQUID_INDEXER_HTTP_URL;
    if (!base) {
      return NextResponse.json(
        { error: "Missing HYPERLIQUID_INDEXER_HTTP_URL in .env" },
        { status: 400 }
      );
    }

    const body = await req.json();
    const now = Date.now();
    const hours = Math.max(1, Math.min(24 * 30, Number(body?.hours || 24)));
    const startTime = Number(body?.startTime || (now - hours * 60 * 60 * 1000));
    const endTime = Number(body?.endTime || now);
    const limit = Math.max(10, Math.min(5000, Number(body?.limit || 500)));

    const url = new URL(base);
    url.searchParams.set("startTime", String(startTime));
    url.searchParams.set("endTime", String(endTime));
    url.searchParams.set("limit", String(limit));

    const headers = { "Content-Type": "application/json" };
    const apiKey = process.env.HYPERLIQUID_INDEXER_API_KEY;
    const authHeader = process.env.HYPERLIQUID_INDEXER_AUTH_HEADER || "x-api-key";
    if (apiKey) headers[authHeader] = apiKey;

    const res = await fetch(url.toString(), { method: "GET", headers, cache: "no-store" });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json({ error: `Indexer error ${res.status}: ${text}` }, { status: res.status });
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Indexer response is not JSON." }, { status: 502 });
    }

    const rows = pickRows(json).sort((a, b) => Number(b?.time || b?.timestamp || 0) - Number(a?.time || a?.timestamp || 0));
    return NextResponse.json({ rows });
  } catch (err) {
    return NextResponse.json({ error: err?.message || "Unexpected error." }, { status: 500 });
  }
}
