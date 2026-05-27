import { NextResponse } from "next/server";

const INFO_ENDPOINT = "https://api.hyperliquid.xyz/info";

export async function POST(req) {
  try {
    const body = await req.json();
    const user = String(body?.user || "").trim();
    const startTime = Number(body?.startTime);
    const endTime = Number(body?.endTime || Date.now());

    if (!user) {
      return NextResponse.json({ error: "Missing user address." }, { status: 400 });
    }

    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
      return NextResponse.json({ error: "Invalid startTime/endTime." }, { status: 400 });
    }

    const payload = {
      type: "userFillsByTime",
      user,
      startTime,
      endTime
    };

    const res = await fetch(INFO_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store"
    });

    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json({ error: `Hyperliquid error ${res.status}: ${text}` }, { status: res.status });
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Invalid JSON from Hyperliquid." }, { status: 502 });
    }

    const fills = Array.isArray(json) ? json : [];
    const liquidationFills = fills.filter((f) => String(f?.type || "").toLowerCase().includes("liquidation"));
    return NextResponse.json({ user, total: fills.length, liquidations: liquidationFills });
  } catch (err) {
    return NextResponse.json({ error: err?.message || "Unexpected error." }, { status: 500 });
  }
}
