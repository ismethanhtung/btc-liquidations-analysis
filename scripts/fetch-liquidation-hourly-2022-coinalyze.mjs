import fs from "fs/promises";
import { existsSync, readFileSync } from "fs";
import path from "path";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CHUNK_DAYS = 60;
const SYMBOLS = ["BTC-PERPETUAL.2", "BTCUSDT_PERP.A", "BTCUSD_PERP.A"];

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

function toIsoHour(ms) {
  return new Date(ms).toISOString().slice(0, 19) + "Z";
}

async function fetchChunk({ apiKey, symbol, fromMs, toMs }) {
  const url = new URL("https://api.coinalyze.net/v1/liquidation-history");
  url.searchParams.set("symbols", symbol);
  url.searchParams.set("interval", "1hour");
  url.searchParams.set("from", String(Math.floor(fromMs / 1000)));
  url.searchParams.set("to", String(Math.floor(toMs / 1000)));

  const res = await fetch(url, {
    headers: {
      api_key: apiKey,
      Accept: "application/json"
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  const json = await res.json();
  const item = Array.isArray(json) ? json[0] : null;
  const history = item?.history ?? [];
  if (!Array.isArray(history)) return [];

  return history
    .map((x) => {
      const ts = Number(x.t ?? 0) * 1000;
      const longUsd = Number(x.l ?? 0);
      const shortUsd = Number(x.s ?? 0);
      return {
        timestamp: toIsoHour(ts),
        ts,
        longUsd,
        shortUsd,
        totalUsd: longUsd + shortUsd
      };
    })
    .filter((x) => Number.isFinite(x.ts) && x.ts > 0);
}

async function fetchForSymbol({ apiKey, symbol, startMs, endMs }) {
  const out = new Map();

  for (let fromMs = startMs; fromMs < endMs; fromMs += CHUNK_DAYS * DAY_MS) {
    const toMs = Math.min(fromMs + CHUNK_DAYS * DAY_MS - 1000, endMs);
    try {
      const rows = await fetchChunk({ apiKey, symbol, fromMs, toMs });
      for (const r of rows) out.set(r.ts, r);
      console.log(`${symbol} ${new Date(fromMs).toISOString()}..${new Date(toMs).toISOString()} => ${rows.length}`);
    } catch (e) {
      console.error(`${symbol} ${new Date(fromMs).toISOString()}..${new Date(toMs).toISOString()} => ERR ${e.message}`);
    }

    await new Promise((r) => setTimeout(r, 250));
  }

  return Array.from(out.values()).sort((a, b) => a.ts - b.ts);
}

function toCsv(rows) {
  const head = "timestamp,longUsd,shortUsd,totalUsd\n";
  const body = rows.map((r) => `${r.timestamp},${r.longUsd},${r.shortUsd},${r.totalUsd}`).join("\n");
  return head + body + "\n";
}

async function main() {
  loadDotEnv();
  const apiKey = process.env.COINALYZE_API_KEY;
  if (!apiKey) throw new Error("Missing COINALYZE_API_KEY");

  const startMs = Date.parse("2022-01-01T00:00:00Z");
  const endMs = Date.parse("2023-12-31T23:59:59Z");

  let best = [];
  for (const symbol of SYMBOLS) {
    const rows = await fetchForSymbol({ apiKey, symbol, startMs, endMs });
    if (rows.length > best.length) best = rows;
  }

  const dataDir = path.join(process.cwd(), "data");
  await fs.mkdir(dataDir, { recursive: true });

  const jsonPath = path.join(dataDir, "btc_liquidation_hourly_2022_2y_coinalyze.json");
  const csvPath = path.join(dataDir, "btc_liquidation_hourly_2022_2y_coinalyze.csv");

  const clean = best.map(({ ts, ...rest }) => rest);
  await fs.writeFile(jsonPath, JSON.stringify(clean, null, 2));
  await fs.writeFile(csvPath, toCsv(clean));

  const first = clean[0]?.timestamp ?? "N/A";
  const last = clean[clean.length - 1]?.timestamp ?? "N/A";
  console.log(`Saved ${clean.length} rows`);
  console.log(`Range ${first} -> ${last}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`CSV: ${csvPath}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
