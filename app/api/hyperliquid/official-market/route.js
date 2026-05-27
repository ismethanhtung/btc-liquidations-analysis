import { NextResponse } from "next/server";

const INFO_ENDPOINT = "https://api.hyperliquid.xyz/info";
const DEFAULT_COINS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "HYPE"];

async function postInfo(payload) {
  const res = await fetch(INFO_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store"
  });
  if (!res.ok) {
    throw new Error(`Hyperliquid error ${res.status}`);
  }
  return res.json();
}

export async function POST(req) {
  try {
    const body = await req.json();
    const requestedCoins = Array.isArray(body?.coins) ? body.coins : DEFAULT_COINS;
    const coins = requestedCoins.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 30);
    const perCoinLimit = Math.max(1, Math.min(500, Number(body?.perCoinLimit || 100)));
    const startTime = Number(body?.startTime || 0);

    const all = await Promise.all(
      coins.map(async (coin) => {
        const rows = await postInfo({ type: "recentTrades", coin });
        return Array.isArray(rows) ? rows.slice(0, perCoinLimit) : [];
      })
    );

    const trades = all
      .flat()
      .filter((x) => (startTime > 0 ? Number(x?.time || 0) >= startTime : true))
      .sort((a, b) => Number(b?.time || 0) - Number(a?.time || 0));
    const minTime = trades.length ? Math.min(...trades.map((x) => Number(x?.time || 0))) : null;
    const maxTime = trades.length ? Math.max(...trades.map((x) => Number(x?.time || 0))) : null;
    return NextResponse.json({ coins, trades, minTime, maxTime, supportsFullRange: false });
  } catch (err) {
    return NextResponse.json({ error: err?.message || "Unexpected error." }, { status: 500 });
  }
}
