import fs from 'node:fs/promises';
import path from 'node:path';

const API_KEY = process.env.COINGLASS_API_KEY;
if (!API_KEY) throw new Error('Missing COINGLASS_API_KEY');

const BASE = 'https://open-api-v4.coinglass.com/api/futures/liquidation/aggregated-history';
const HOUR = 60 * 60 * 1000;

function toCsv(rows) {
  const header = 'timestamp,datetime_utc,longUsd,shortUsd,totalUsd';
  return [header, ...rows.map((r) => `${r.timestamp},${new Date(r.timestamp).toISOString()},${r.longUsd},${r.shortUsd},${r.totalUsd}`)].join('\n');
}

async function fetchRows({ startTime, endTime, interval = '1h', exchangeList = 'Binance,Bybit,OKX', symbol = 'BTC', limit = 1000 }) {
  const url = new URL(BASE);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('exchange_list', exchangeList);
  url.searchParams.set('start_time', String(startTime));
  url.searchParams.set('end_time', String(endTime));
  url.searchParams.set('limit', String(limit));

  const res = await fetch(url.toString(), {
    headers: { accept: 'application/json', 'CG-API-KEY': API_KEY },
    cache: 'no-store'
  });
  const j = await res.json();
  return { status: res.status, payload: j };
}

function normalize(data) {
  return (Array.isArray(data) ? data : []).map((r) => {
    const timestamp = Number(r.time || 0);
    const longUsd = Number(r.aggregated_long_liquidation_usd || 0);
    const shortUsd = Number(r.aggregated_short_liquidation_usd || 0);
    const totalUsd = longUsd + shortUsd;
    return { timestamp, longUsd, shortUsd, totalUsd };
  }).filter((r) => r.timestamp > 0).sort((a, b) => a.timestamp - b.timestamp);
}

async function main() {
  await fs.mkdir(path.join(process.cwd(), 'data'), { recursive: true });

  const now = Date.now();
  const start10y = now - 10 * 365 * 24 * HOUR;
  const start5y = now - 5 * 365 * 24 * HOUR;

  const r1 = await fetchRows({ startTime: start10y, endTime: now, interval: '1h' });
  const rows1h = normalize(r1.payload?.data || []);

  const file1 = path.join(process.cwd(), 'data', 'coinglass_BTC_liquidation_10y_1h.csv');
  await fs.writeFile(file1, toCsv(rows1h), 'utf8');

  const r2 = await fetchRows({ startTime: start5y, endTime: now, interval: '5m' });
  let rows10m = [];
  let note10m = '';

  if (String(r2.payload?.code) === '0') {
    const rows5m = normalize(r2.payload?.data || []);
    for (let i = 0; i + 1 < rows5m.length; i += 2) {
      const a = rows5m[i];
      const b = rows5m[i + 1];
      rows10m.push({
        timestamp: a.timestamp,
        longUsd: a.longUsd + b.longUsd,
        shortUsd: a.shortUsd + b.shortUsd,
        totalUsd: a.totalUsd + b.totalUsd
      });
    }
    note10m = 'Derived from 5m by merging 2 rows per candle.';
  } else {
    note10m = `Unavailable on current plan. code=${r2.payload?.code} msg=${r2.payload?.msg}`;
  }

  const file2 = path.join(process.cwd(), 'data', 'coinglass_BTC_liquidation_5y_10m.csv');
  await fs.writeFile(file2, toCsv(rows10m), 'utf8');

  const meta = {
    generatedAt: new Date().toISOString(),
    requested: {
      file1: { range: '10y', interval: '1h' },
      file2: { range: '5y', interval: '10m' }
    },
    file1: {
      path: file1,
      rows: rows1h.length,
      first: rows1h[0]?.timestamp ?? null,
      last: rows1h.at(-1)?.timestamp ?? null,
      apiCode: r1.payload?.code,
      apiMsg: r1.payload?.msg ?? null
    },
    file2: {
      path: file2,
      rows: rows10m.length,
      first: rows10m[0]?.timestamp ?? null,
      last: rows10m.at(-1)?.timestamp ?? null,
      apiCode: r2.payload?.code,
      apiMsg: r2.payload?.msg ?? null,
      note: note10m
    }
  };

  const metaPath = path.join(process.cwd(), 'data', 'coinglass_BTC_liquidation_export_meta.json');
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  console.log(JSON.stringify(meta, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
