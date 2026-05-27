import fs from 'node:fs/promises';
import path from 'node:path';

const API_KEY = process.env.COINGLASS_API_KEY;
if (!API_KEY) throw new Error('Missing COINGLASS_API_KEY');

const BASE = 'https://open-api-v4.coinglass.com/api/futures/liquidation/aggregated-history';
const HOUR = 3600_000;
const LIMIT = 1000;
const MAX_CALLS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(endTime) {
  const url = new URL(BASE);
  url.searchParams.set('symbol', 'BTC');
  url.searchParams.set('exchange_list', 'Binance,Bybit,OKX');
  url.searchParams.set('interval', '1h');
  url.searchParams.set('end_time', String(endTime));
  url.searchParams.set('limit', String(LIMIT));

  for (let retry = 0; retry < 8; retry += 1) {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'CG-API-KEY': API_KEY },
      cache: 'no-store'
    });
    const j = await res.json().catch(() => ({}));
    const code = String(j?.code ?? '');

    if (res.ok && code === '0') {
      const rows = (j.data || [])
        .map((r) => ({
          timestamp: Number(r.time || 0),
          longUsd: Number(r.aggregated_long_liquidation_usd || 0),
          shortUsd: Number(r.aggregated_short_liquidation_usd || 0),
          totalUsd: Number(r.aggregated_long_liquidation_usd || 0) + Number(r.aggregated_short_liquidation_usd || 0)
        }))
        .filter((r) => r.timestamp > 0)
        .sort((a, b) => a.timestamp - b.timestamp);
      return { rows, code: '0', msg: null };
    }

    if (code === '429') {
      const waitMs = Math.min(60_000, 1500 * (retry + 1));
      await sleep(waitMs);
      continue;
    }

    return { rows: [], code, msg: j?.msg || `HTTP ${res.status}` };
  }

  return { rows: [], code: '429', msg: 'Too Many Requests after retries' };
}

function toCsv(rows) {
  return [
    'timestamp,datetime_utc,longUsd,shortUsd,totalUsd',
    ...rows.map((r) => `${r.timestamp},${new Date(r.timestamp).toISOString()},${r.longUsd},${r.shortUsd},${r.totalUsd}`)
  ].join('\n');
}

const now = Date.now();
const targetStart = now - 10 * 365 * 24 * HOUR;
const map = new Map();
let endCursor = now;
let calls = 0;
let repeatedOldestCount = 0;
let prevMinTs = null;
let stopReason = 'unknown';

while (calls < MAX_CALLS) {
  const { rows, code, msg } = await fetchPage(endCursor);
  calls += 1;

  if (code !== '0') {
    stopReason = `api_code_${code}:${msg}`;
    break;
  }
  if (!rows.length) {
    stopReason = 'empty_page';
    break;
  }

  for (const r of rows) {
    if (r.timestamp >= targetStart && r.timestamp <= now) {
      map.set(r.timestamp, r);
    }
  }

  const minTs = rows[0].timestamp;
  const maxTs = rows[rows.length - 1].timestamp;

  if (calls % 25 === 0) {
    console.log(`calls=${calls} page=[${new Date(minTs).toISOString()} -> ${new Date(maxTs).toISOString()}] kept=${map.size}`);
  }

  if (prevMinTs !== null && minTs === prevMinTs) {
    repeatedOldestCount += 1;
  } else {
    repeatedOldestCount = 0;
  }
  prevMinTs = minTs;

  if (repeatedOldestCount >= 3) {
    stopReason = 'stuck_same_oldest_timestamp';
    break;
  }

  if (minTs <= targetStart) {
    stopReason = 'reached_target_start';
    break;
  }

  endCursor = minTs - 1;
  await sleep(250);
}

const outRows = [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
await fs.mkdir(path.join(process.cwd(), 'data'), { recursive: true });
const csvPath = path.join(process.cwd(), 'data', 'coinglass_BTC_liquidation_10y_1h.csv');
const metaPath = path.join(process.cwd(), 'data', 'coinglass_BTC_liquidation_10y_1h.meta.json');
await fs.writeFile(csvPath, toCsv(outRows), 'utf8');
await fs.writeFile(metaPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  calls,
  stopReason,
  rows: outRows.length,
  targetStart,
  targetEnd: now,
  first: outRows[0]?.timestamp ?? null,
  last: outRows[outRows.length - 1]?.timestamp ?? null,
  firstIso: outRows[0] ? new Date(outRows[0].timestamp).toISOString() : null,
  lastIso: outRows[outRows.length - 1] ? new Date(outRows[outRows.length - 1].timestamp).toISOString() : null
}, null, 2), 'utf8');

console.log(JSON.stringify({ calls, stopReason, rows: outRows.length, firstIso: outRows[0] ? new Date(outRows[0].timestamp).toISOString() : null, lastIso: outRows[outRows.length - 1] ? new Date(outRows[outRows.length - 1].timestamp).toISOString() : null, csvPath, metaPath }, null, 2));
