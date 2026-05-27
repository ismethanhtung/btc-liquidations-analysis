import fs from "fs/promises";
import path from "path";
import { existsSync, readFileSync } from "fs";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const LIQ_INTERVAL = "daily";
const PRICE_INTERVAL = "1d";
const COINALYZE_SYMBOLS = ["BTCUSDT_PERP.A", "BTCUSD_PERP.A"];

function toIsoHour(ms) {
  return new Date(ms).toISOString().slice(0, 19) + "Z";
}

function loadDotEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;

  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}

async function fetchCoinalyze({ apiKey, fromMs, toMs }) {
  const endpoint = "https://api.coinalyze.net/v1/liquidation-history";
  let lastErr = null;

  for (const symbol of COINALYZE_SYMBOLS) {
    const out = new Map();
    let cursorToMs = toMs;
    let guard = 0;

    while (cursorToMs > fromMs && guard < 30) {
      guard += 1;
      const url = new URL(endpoint);
      url.searchParams.set("symbols", symbol);
      url.searchParams.set("interval", LIQ_INTERVAL);
      url.searchParams.set("from", String(Math.floor(fromMs / 1000)));
      url.searchParams.set("to", String(Math.floor(cursorToMs / 1000)));

      const res = await fetch(url, {
        headers: {
          api_key: apiKey,
          Accept: "application/json"
        }
      });

      if (!res.ok) {
        lastErr = new Error(`Coinalyze error ${res.status}: ${await res.text()}`);
        break;
      }

      const json = await res.json();
      const item = Array.isArray(json) ? json[0] : null;
      const history = item?.history ?? [];
      if (!Array.isArray(history) || history.length === 0) break;

      let minTsMs = Number.POSITIVE_INFINITY;
      for (const x of history) {
        const tsSec = Number(x.t ?? 0);
        if (!Number.isFinite(tsSec) || tsSec <= 0) continue;
        const ts = tsSec * 1000;
        minTsMs = Math.min(minTsMs, ts);
        const longUsd = Number(x.l ?? 0);
        const shortUsd = Number(x.s ?? 0);
        out.set(ts, { ts, longUsd, shortUsd, totalUsd: longUsd + shortUsd });
      }

      if (!Number.isFinite(minTsMs) || minTsMs <= fromMs) break;
      const nextCursorTo = minTsMs - 1000;
      if (nextCursorTo >= cursorToMs) break;
      cursorToMs = nextCursorTo;
    }

    if (out.size > 0) {
      return Array.from(out.values()).sort((a, b) => a.ts - b.ts);
    }
  }

  throw lastErr ?? new Error("Coinalyze request failed for all configured symbols");
}

async function fetchBinanceKline({ startMs, endMs }) {
  const out = new Map();
  let cursor = startMs;
  const stepMs = PRICE_INTERVAL === "1d" ? DAY_MS : HOUR_MS;

  while (cursor < endMs) {
    const url = new URL("https://api.binance.com/api/v3/klines");
    url.searchParams.set("symbol", "BTCUSDT");
    url.searchParams.set("interval", PRICE_INTERVAL);
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(endMs));
    url.searchParams.set("limit", "1000");

    const res = await fetch(url);
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Binance error ${res.status}: ${t}`);
    }

    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const row of rows) {
      out.set(Number(row[0]), Number(row[4]));
    }

    const last = rows[rows.length - 1][0];
    cursor = Number(last) + stepMs;
  }

  return out;
}

function toCsv(rows) {
  const head = "timestamp,longUsd,shortUsd,totalUsd,btcPrice\n";
  const body = rows.map((r) => `${r.timestamp},${r.longUsd},${r.shortUsd},${r.totalUsd},${r.btcPrice}`).join("\n");
  return head + body + "\n";
}

async function main() {
  loadDotEnv();
  const apiKey = process.env.COINALYZE_API_KEY;
  const endMs = Date.now();
  const startMs = endMs - 730 * DAY_MS;

  if (!apiKey) {
    throw new Error("Missing COINALYZE_API_KEY. Set it in .env or shell env before running npm run fetch:data");
  }

  const liq = await fetchCoinalyze({ apiKey, fromMs: startMs, toMs: endMs });
  const priceMap = await fetchBinanceKline({ startMs, endMs });

  const merged = liq.map((x) => {
    const snapped = LIQ_INTERVAL === "daily"
      ? Math.floor(x.ts / DAY_MS) * DAY_MS
      : Math.floor(x.ts / HOUR_MS) * HOUR_MS;
    return {
      timestamp: toIsoHour(snapped),
      longUsd: x.longUsd,
      shortUsd: x.shortUsd,
      totalUsd: x.totalUsd,
      btcPrice: priceMap.get(snapped) ?? null
    };
  }).filter((x) => x.btcPrice !== null);

  const dataDir = path.join(process.cwd(), "data");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "btc_liquidation_2y.json"), JSON.stringify(merged, null, 2));
  await fs.writeFile(path.join(dataDir, "btc_liquidation_2y.csv"), toCsv(merged));

  console.log(`Saved ${merged.length} rows to data/`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
