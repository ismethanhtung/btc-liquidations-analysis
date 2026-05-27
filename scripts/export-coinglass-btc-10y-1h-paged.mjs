import fs from 'node:fs/promises';
import path from 'node:path';

const API_KEY = process.env.COINGLASS_API_KEY;
if (!API_KEY) throw new Error('Missing COINGLASS_API_KEY');

const BASE = 'https://open-api-v4.coinglass.com/api/futures/liquidation/aggregated-history';
const HOUR = 60 * 60 * 1000;
const LIMIT = 1000;

async function fetchPage(endTime) {
  const url = new URL(BASE);
  url.searchParams.set('symbol', 'BTC');
  url.searchParams.set('exchange_list', 'Binance,Bybit,OKX');
  url.searchParams.set('interval', '1h');
  url.searchParams.set('end_time', String(endTime));
  url.searchParams.set('limit', String(LIMIT));
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'CG-API-KEY': API_KEY },
    cache: 'no-store'
  });
  const j = await res.json();
  if (!res.ok || String(j?.code) !== '0') {
    throw new Error(`API error status=${res.status} code=${j?.code} msg=${j?.msg}`);
  }
  const rows = (j.data || []).map((r) => ({
    timestamp: Number(r.time || 0),
    longUsd: Number(r.aggregated_long_liquidation_usd || 0),
    shortUsd: Number(r.aggregated_short_liquidation_usd || 0),
    totalUsd: Number(r.aggregated_long_liquidation_usd || 0) + Number(r.aggregated_short_liquidation_usd || 0)
  })).filter((r) => r.timestamp > 0).sort((a,b)=>a.timestamp-b.timestamp);
  return rows;
}

function toCsv(rows) {
  return ['timestamp,datetime_utc,longUsd,shortUsd,totalUsd', ...rows.map(r => `${r.timestamp},${new Date(r.timestamp).toISOString()},${r.longUsd},${r.shortUsd},${r.totalUsd}`)].join('\n');
}

const now = Date.now();
const targetStart = now - 10 * 365 * 24 * HOUR;
let endCursor = now;
const map = new Map();
let calls = 0;
let done = false;

while (!done) {
  const rows = await fetchPage(endCursor);
  calls += 1;
  if (!rows.length) break;

  for (const r of rows) {
    if (r.timestamp >= targetStart && r.timestamp <= now) {
      map.set(r.timestamp, r);
    }
  }

  const minTs = rows[0].timestamp;
  const maxTs = rows[rows.length - 1].timestamp;
  if (calls % 10 === 0) {
    console.log(`calls=${calls} window=${new Date(minTs).toISOString()} -> ${new Date(maxTs).toISOString()} kept=${map.size}`);
  }

  if (minTs <= targetStart) {
    done = true;
  } else {
    endCursor = minTs - 1;
  }

  if (calls > 300) break;
}

const outRows = [...map.values()].sort((a,b)=>a.timestamp-b.timestamp);
await fs.mkdir(path.join(process.cwd(), 'data'), { recursive: true });
const csvPath = path.join(process.cwd(), 'data', 'coinglass_BTC_liquidation_10y_1h.csv');
const metaPath = path.join(process.cwd(), 'data', 'coinglass_BTC_liquidation_10y_1h.meta.json');
await fs.writeFile(csvPath, toCsv(outRows), 'utf8');
await fs.writeFile(metaPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  calls,
  rows: outRows.length,
  targetStart,
  targetEnd: now,
  first: outRows[0]?.timestamp ?? null,
  last: outRows[outRows.length - 1]?.timestamp ?? null
}, null, 2), 'utf8');

console.log(JSON.stringify({calls,rows:outRows.length,first:outRows[0]?.timestamp,last:outRows[outRows.length-1]?.timestamp,csvPath,metaPath}, null, 2));
