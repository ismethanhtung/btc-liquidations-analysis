import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

const BASE_URL = "https://open-api-v4.coinglass.com/api/futures/liquidation/aggregated-history";
const MS_HOUR = 60 * 60 * 1000;
const MAX_LIMIT = 1000;

function normalizeRow(row) {
  const ts = Number(row?.time ?? row?.t ?? row?.timestamp ?? 0);
  const longUsd = Number(
    row?.longLiquidationUsd ??
      row?.longUsd ??
      row?.long ??
      row?.aggregated_long_liquidation_usd ??
      row?.long_liquidation_usd ??
      0
  );
  const shortUsd = Number(
    row?.shortLiquidationUsd ??
      row?.shortUsd ??
      row?.short ??
      row?.aggregated_short_liquidation_usd ??
      row?.short_liquidation_usd ??
      0
  );
  const totalUsdRaw = Number(
    row?.totalLiquidationUsd ??
      row?.totalUsd ??
      row?.total ??
      row?.sum ??
      (longUsd + shortUsd)
  );
  const totalUsd = Number.isFinite(totalUsdRaw) ? totalUsdRaw : (longUsd + shortUsd);
  return { timestamp: ts, longUsd, shortUsd, totalUsd };
}

function rowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.list)) return payload.data.list;
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.rows)) return payload.rows;
  return [];
}

function toCsv(rows) {
  const header = "timestamp,datetime_utc,longUsd,shortUsd,totalUsd";
  const lines = rows.map((r) => {
    const dt = new Date(r.timestamp).toISOString();
    return `${r.timestamp},${dt},${r.longUsd},${r.shortUsd},${r.totalUsd}`;
  });
  return [header, ...lines].join("\n");
}

async function fetchChunk({ apiKey, startTime, endTime, symbol = "BTC", interval = "1h", exchangeList = "Binance,Bybit,OKX" }) {
  const url = new URL(BASE_URL);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("exchange_list", exchangeList);
  url.searchParams.set("start_time", String(startTime));
  url.searchParams.set("end_time", String(endTime));
  url.searchParams.set("limit", String(MAX_LIMIT));

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "CG-API-KEY": apiKey
    },
    cache: "no-store"
  });

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Coinglass non-JSON response: ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`Coinglass HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (String(payload?.code ?? "0") !== "0" && payload?.success === false) {
    throw new Error(`Coinglass API error: ${payload?.msg || "unknown"}`);
  }
  return rowsFromPayload(payload).map(normalizeRow).filter((r) => Number.isFinite(r.timestamp) && r.timestamp > 0);
}

export async function POST(req) {
  try {
    const apiKey = process.env.COINGLASS_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Missing COINGLASS_API_KEY in .env" }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const endTime = Number(body?.endTime || Date.now());
    const years = Number(body?.years || 2);
    const startTime = Number(body?.startTime || (endTime - years * 365 * 24 * MS_HOUR));
    const symbol = String(body?.symbol || "BTC").toUpperCase();
    const interval = String(body?.interval || "1h");
    const exchangeList = String(body?.exchangeList || "Binance,Bybit,OKX");

    const chunkSpan = MAX_LIMIT * MS_HOUR;
    const allRows = [];
    let cursor = startTime;
    while (cursor < endTime) {
      const chunkEnd = Math.min(endTime, cursor + chunkSpan);
      const rows = await fetchChunk({ apiKey, startTime: cursor, endTime: chunkEnd, symbol, interval, exchangeList });
      allRows.push(...rows);
      cursor = chunkEnd + MS_HOUR;
    }

    const dedup = new Map();
    for (const r of allRows) dedup.set(r.timestamp, r);
    const rows = [...dedup.values()].sort((a, b) => a.timestamp - b.timestamp);

    await fs.mkdir(path.join(process.cwd(), "data"), { recursive: true });
    const csvName = `coinglass_${symbol}_liquidation_${interval}_2y.csv`;
    const jsonName = `coinglass_${symbol}_liquidation_${interval}_2y.json`;
    const csvPath = path.join(process.cwd(), "data", csvName);
    const jsonPath = path.join(process.cwd(), "data", jsonName);
    await fs.writeFile(csvPath, toCsv(rows), "utf8");
    await fs.writeFile(jsonPath, JSON.stringify(rows, null, 2), "utf8");

    const firstTs = rows.length ? rows[0].timestamp : null;
    const lastTs = rows.length ? rows[rows.length - 1].timestamp : null;
    const coveredHours = (firstTs && lastTs) ? Math.round((lastTs - firstTs) / MS_HOUR) + 1 : 0;

    return NextResponse.json({
      ok: true,
      symbol,
      interval,
      rows: rows.length,
      startTime,
      endTime,
      firstTimestamp: firstTs,
      lastTimestamp: lastTs,
      coveredHours,
      csvPath,
      jsonPath,
      preview: rows.slice(-20).reverse()
    });
  } catch (err) {
    return NextResponse.json({ error: err?.message || "Unexpected error." }, { status: 500 });
  }
}
