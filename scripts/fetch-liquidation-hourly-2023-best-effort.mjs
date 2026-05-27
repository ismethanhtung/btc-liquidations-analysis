import fs from "fs/promises";
import { existsSync, readFileSync } from "fs";
import path from "path";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CHUNK_DAYS = 30;
const RETRIES = 3;

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

function isoHour(ms) {
  return new Date(ms).toISOString().slice(0, 19) + "Z";
}

async function fetchJsonWithRetry(url, apiKey) {
  let err;
  for (let i = 1; i <= RETRIES; i += 1) {
    try {
      const res = await fetch(url, { headers: { api_key: apiKey, Accept: "application/json" } });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      return await res.json();
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
  throw err;
}

async function fetchSymbols(apiKey) {
  const url = "https://api.coinalyze.net/v1/future-markets";
  const json = await fetchJsonWithRetry(url, apiKey);
  const arr = Array.isArray(json) ? json : [];
  return arr
    .filter((x) => x.base_asset === "BTC" && x.is_perpetual)
    .map((x) => x.symbol)
    .filter(Boolean);
}

async function fetchLiqChunk({ apiKey, symbol, fromMs, toMs }) {
  const url = new URL("https://api.coinalyze.net/v1/liquidation-history");
  url.searchParams.set("symbols", symbol);
  url.searchParams.set("interval", "1hour");
  url.searchParams.set("from", String(Math.floor(fromMs / 1000)));
  url.searchParams.set("to", String(Math.floor(toMs / 1000)));

  const json = await fetchJsonWithRetry(url, apiKey);
  const history = Array.isArray(json) ? (json[0]?.history ?? []) : [];
  if (!Array.isArray(history)) return [];

  return history
    .map((x) => {
      const ts = Number(x.t ?? 0) * 1000;
      const longUsd = Number(x.l ?? 0);
      const shortUsd = Number(x.s ?? 0);
      return {
        ts: Math.floor(ts / HOUR_MS) * HOUR_MS,
        longUsd,
        shortUsd,
        totalUsd: longUsd + shortUsd,
      };
    })
    .filter((x) => Number.isFinite(x.ts) && x.ts > 0);
}

async function main() {
  loadDotEnv();
  const apiKey = process.env.COINALYZE_API_KEY;
  if (!apiKey) throw new Error("Missing COINALYZE_API_KEY");

  const startMs = Date.parse("2023-01-01T00:00:00Z");
  const endMs = Date.now();

  const symbols = await fetchSymbols(apiKey);
  console.log(`Found ${symbols.length} BTC perpetual symbols`);

  const byHour = new Map();
  const symbolHitCount = new Map();

  for (const symbol of symbols) {
    let symbolRows = 0;

    for (let fromMs = startMs; fromMs < endMs; fromMs += CHUNK_DAYS * DAY_MS) {
      const toMs = Math.min(fromMs + CHUNK_DAYS * DAY_MS - 1000, endMs);
      try {
        const rows = await fetchLiqChunk({ apiKey, symbol, fromMs, toMs });
        symbolRows += rows.length;

        for (const r of rows) {
          const current = byHour.get(r.ts) ?? { longUsd: 0, shortUsd: 0, totalUsd: 0, sourceCount: 0, symbols: new Set() };
          current.longUsd += r.longUsd;
          current.shortUsd += r.shortUsd;
          current.totalUsd += r.totalUsd;
          if (!current.symbols.has(symbol)) {
            current.symbols.add(symbol);
            current.sourceCount += 1;
          }
          byHour.set(r.ts, current);
        }
      } catch (e) {
        console.error(`${symbol} ${isoHour(fromMs)}..${isoHour(toMs)} ERR ${e.message}`);
      }

      await new Promise((r) => setTimeout(r, 120));
    }

    symbolHitCount.set(symbol, symbolRows);
    console.log(`${symbol} => ${symbolRows} hourly points`);
  }

  const rows = [];
  for (let ts = Math.floor(startMs / HOUR_MS) * HOUR_MS; ts <= endMs; ts += HOUR_MS) {
    const v = byHour.get(ts);
    if (v) {
      rows.push({
        timestamp: isoHour(ts),
        longUsd: v.longUsd,
        shortUsd: v.shortUsd,
        totalUsd: v.totalUsd,
        sourceCount: v.sourceCount,
        missing: 0,
      });
    } else {
      rows.push({
        timestamp: isoHour(ts),
        longUsd: null,
        shortUsd: null,
        totalUsd: null,
        sourceCount: 0,
        missing: 1,
      });
    }
  }

  let missingHours = 0;
  let longestMissingStreak = 0;
  let curStreak = 0;
  for (const r of rows) {
    if (r.missing) {
      missingHours += 1;
      curStreak += 1;
      if (curStreak > longestMissingStreak) longestMissingStreak = curStreak;
    } else {
      curStreak = 0;
    }
  }

  const dataDir = path.join(process.cwd(), "data");
  await fs.mkdir(dataDir, { recursive: true });

  const base = path.join(dataDir, "btc_liquidation_hourly_2023_now_coinalyze_best_effort");
  const outJson = `${base}.json`;
  const outCsv = `${base}.csv`;
  const metaJson = `${base}.meta.json`;

  const csvHead = "timestamp,longUsd,shortUsd,totalUsd,sourceCount,missing\n";
  const csvBody = rows
    .map((r) => `${r.timestamp},${r.longUsd ?? ""},${r.shortUsd ?? ""},${r.totalUsd ?? ""},${r.sourceCount},${r.missing}`)
    .join("\n");

  await fs.writeFile(outJson, JSON.stringify(rows, null, 2));
  await fs.writeFile(outCsv, csvHead + csvBody + "\n");

  const topSymbols = Array.from(symbolHitCount.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([symbol, points]) => ({ symbol, points }));

  const meta = {
    range: { start: isoHour(startMs), end: isoHour(endMs) },
    totalHours: rows.length,
    coveredHours: rows.length - missingHours,
    missingHours,
    coveragePct: rows.length ? Number((((rows.length - missingHours) / rows.length) * 100).toFixed(4)) : 0,
    longestMissingStreakHours: longestMissingStreak,
    symbolCount: symbols.length,
    symbolPoints: topSymbols,
  };

  await fs.writeFile(metaJson, JSON.stringify(meta, null, 2));

  console.log(`Saved: ${outCsv}`);
  console.log(`Saved: ${outJson}`);
  console.log(`Saved: ${metaJson}`);
  console.log(`Coverage: ${meta.coveredHours}/${meta.totalHours} (${meta.coveragePct}%)`);
  console.log(`Longest missing streak (hours): ${meta.longestMissingStreakHours}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
