import fs from 'node:fs';
import path from 'node:path';

function readCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  const [header, ...lines] = raw.split(/\r?\n/);
  const headers = header.split(',');
  return lines.map((line) => {
    const parts = line.split(',');
    const row = Object.fromEntries(headers.map((h, i) => [h, parts[i] ?? '']));
    const timestamp = Number(row.timestamp || 0);
    const longUsd = Number(row.longUsd || 0);
    const shortUsd = Number(row.shortUsd || 0);
    const totalUsd = Number(row.totalUsd || (longUsd + shortUsd));
    return { timestamp, longUsd, shortUsd, totalUsd };
  }).filter((r) => Number.isFinite(r.timestamp) && r.timestamp > 0).sort((a,b)=>a.timestamp-b.timestamp);
}

async function fetchBinanceKlines(interval, startMs, endMs) {
  const out = [];
  let cursor = startMs;
  const step = interval === '1h' ? 3600_000 : 1800_000;

  while (cursor <= endMs) {
    const url = new URL('https://api.binance.com/api/v3/klines');
    url.searchParams.set('symbol', 'BTCUSDT');
    url.searchParams.set('interval', interval);
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(endMs));
    url.searchParams.set('limit', '1000');

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Binance ${interval} ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const r of rows) {
      out.push({
        timestamp: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4])
      });
    }

    const next = Number(rows[rows.length - 1][0]) + step;
    if (next <= cursor) break;
    cursor = next;
    if (rows.length < 1000) break;
  }

  const map = new Map();
  for (const r of out) map.set(r.timestamp, r);
  return [...map.values()].sort((a,b)=>a.timestamp-b.timestamp);
}

function rollingStats(values, idx, window) {
  const from = Math.max(0, idx - window + 1);
  const arr = values.slice(from, idx + 1);
  const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
  const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length;
  const std = Math.sqrt(variance) || 1;
  return { mean, std };
}

function quantile(arr, p) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x,y)=>x-y);
  const i = (a.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi]-a[lo])*(i-lo);
}

function pct(n) {
  return `${(n*100).toFixed(2)}%`;
}

function analyze(rows, klines, label, barHours) {
  const priceByTs = new Map(klines.map((k) => [k.timestamp, k]));
  const merged = rows.map((r) => ({ ...r, price: priceByTs.get(r.timestamp) })).filter((r) => r.price);
  const totals = merged.map((x) => x.totalUsd);
  const q95 = quantile(totals, 0.95);
  const q99 = quantile(totals, 0.99);

  const events = [];
  for (let i = 0; i < merged.length; i += 1) {
    const m = merged[i];
    const dominance = m.totalUsd > 0 ? m.longUsd / m.totalUsd : 0;
    const rs = rollingStats(totals, i, Math.round((24 * 7) / barHours));
    const z = (m.totalUsd - rs.mean) / rs.std;
    const cascade = m.totalUsd >= q95 && dominance >= 0.65 && z >= 1.5;
    if (!cascade) continue;

    const entry = m.price.close;
    const fwdBars = [1, 2, 4, 8, 12, 24].map((h) => Math.max(1, Math.round(h / barHours)));
    const returns = {};
    for (const b of fwdBars) {
      const j = i + b;
      if (j < merged.length) returns[`r${b}`] = (merged[j].price.close - entry) / entry;
    }

    const horizon = Math.max(1, Math.round(24 / barHours));
    const slice = merged.slice(i + 1, Math.min(merged.length, i + 1 + horizon));
    const best = slice.length ? Math.max(...slice.map((x) => (x.price.high - entry) / entry)) : null;
    const worst = slice.length ? Math.min(...slice.map((x) => (x.price.low - entry) / entry)) : null;

    events.push({
      timestamp: m.timestamp,
      iso: new Date(m.timestamp).toISOString(),
      totalUsd: m.totalUsd,
      longShare: dominance,
      z,
      entry,
      returns,
      best24h: best,
      worst24h: worst
    });
  }

  const r1 = events.map((e) => e.returns.r1).filter((x) => Number.isFinite(x));
  const r2 = events.map((e) => e.returns.r2).filter((x) => Number.isFinite(x));
  const r4 = events.map((e) => e.returns.r4).filter((x) => Number.isFinite(x));
  const r8 = events.map((e) => e.returns.r8).filter((x) => Number.isFinite(x));
  const win8 = r8.filter((x) => x > 0).length / (r8.length || 1);
  const best24 = events.map((e) => e.best24h).filter((x) => Number.isFinite(x));
  const worst24 = events.map((e) => e.worst24h).filter((x) => Number.isFinite(x));

  const topEvents = [...events].sort((a,b)=>b.totalUsd-a.totalUsd).slice(0, 10);

  return {
    label,
    bars: merged.length,
    start: merged[0] ? new Date(merged[0].timestamp).toISOString() : null,
    end: merged.at(-1) ? new Date(merged.at(-1).timestamp).toISOString() : null,
    q95,
    q99,
    cascadeCount: events.length,
    stats: {
      avgR1: r1.length ? r1.reduce((s,x)=>s+x,0)/r1.length : null,
      avgR2: r2.length ? r2.reduce((s,x)=>s+x,0)/r2.length : null,
      avgR4: r4.length ? r4.reduce((s,x)=>s+x,0)/r4.length : null,
      avgR8: r8.length ? r8.reduce((s,x)=>s+x,0)/r8.length : null,
      winRateR8: win8,
      medianBest24h: quantile(best24, 0.5),
      medianWorst24h: quantile(worst24, 0.5)
    },
    topEvents
  };
}

function buildMarkdown(oneH, thirtyM) {
  const lines = [];
  lines.push('# Liquidation Cascade Research Notes');
  lines.push('');
  lines.push('## User hypotheses (as requested)');
  lines.push('- liquidation cascade — thanh ly day chuyen -> cai nay rat co the can duoc nghien cuu, phan tich, khai thac.');
  lines.push('- toi muon nhu sau: vi du toi co dataset cua liquidation, toi co the nghien cuu ra mot cai, co the biet duoc khi nao vao la tot, vi du toi thay rat nhieu liquidation cascade, rat nhieu long da bi liquidation, thi toi co the biet duoc den khi nao la sap het thi toi se mua vao de no chuan bi len lai, toi se bat nhip de long.');
  lines.push('- nen toi can rat nhieu phan tich, so lieu,... hay dung tap data set cua toi de lam duoc dieu do. voi 2 tap data set quan trong nhat la 2 nam 1h, va 30 phut.');
  lines.push('');
  lines.push('## Datasets used');
  lines.push(`- 2y-1h: ${oneH.start} -> ${oneH.end}, bars=${oneH.bars}`);
  lines.push(`- max-30m: ${thirtyM.start} -> ${thirtyM.end}, bars=${thirtyM.bars}`);
  lines.push('');
  lines.push('## Cascade definition used in this research');
  lines.push('- total liquidation >= P95 of dataset');
  lines.push('- long liquidation share >= 65%');
  lines.push('- z-score of total liquidation >= 1.5 over rolling 7-day window');
  lines.push('');
  lines.push('## Results: 2y-1h');
  lines.push(`- P95=${Math.round(oneH.q95).toLocaleString()} USD, P99=${Math.round(oneH.q99).toLocaleString()} USD`);
  lines.push(`- Cascade events=${oneH.cascadeCount}`);
  lines.push(`- Avg return after 1h=${pct(oneH.stats.avgR1 || 0)}, 2h=${pct(oneH.stats.avgR2 || 0)}, 4h=${pct(oneH.stats.avgR4 || 0)}, 8h=${pct(oneH.stats.avgR8 || 0)}`);
  lines.push(`- Win rate at 8h=${pct(oneH.stats.winRateR8 || 0)}`);
  lines.push(`- Median best move within 24h=${pct(oneH.stats.medianBest24h || 0)}, median worst drawdown within 24h=${pct(oneH.stats.medianWorst24h || 0)}`);
  lines.push('');
  lines.push('## Results: max-30m');
  lines.push(`- P95=${Math.round(thirtyM.q95).toLocaleString()} USD, P99=${Math.round(thirtyM.q99).toLocaleString()} USD`);
  lines.push(`- Cascade events=${thirtyM.cascadeCount}`);
  lines.push(`- Avg return after 1 bar=${pct(thirtyM.stats.avgR1 || 0)}, 2 bars=${pct(thirtyM.stats.avgR2 || 0)}, 4 bars=${pct(thirtyM.stats.avgR4 || 0)}, 8 bars=${pct(thirtyM.stats.avgR8 || 0)}`);
  lines.push(`- Win rate at 8 bars=${pct(thirtyM.stats.winRateR8 || 0)}`);
  lines.push(`- Median best move within 24h=${pct(thirtyM.stats.medianBest24h || 0)}, median worst drawdown within 24h=${pct(thirtyM.stats.medianWorst24h || 0)}`);
  lines.push('');
  lines.push('## Practical exploitation framework (Long after long-side cascade)');
  lines.push('- Step 1: detect cascade bar by thresholds above.');
  lines.push('- Step 2: do not enter immediately. wait 1-2 bars for liquidation intensity to drop below P90 and price to stop making new low.');
  lines.push('- Step 3: entry trigger = close breaks previous bar high while liquidation drops (exhaustion signal).');
  lines.push('- Step 4: stop = cascade low - 0.5 ATR(14), take-profit partial at +1R and +2R.');
  lines.push('- Step 5: avoid entries if funding/OI continue moving against rebound (need extra dataset in next phase).');
  lines.push('');
  lines.push('## Next analysis expansions');
  lines.push('- Add open interest + funding + CVD to discriminate true exhaustion vs continuation crash.');
  lines.push('- Backtest with transaction cost and slippage by session (Asia/EU/US).');
  lines.push('- Build regime segmentation: trend day vs mean-revert day.');
  lines.push('');
  lines.push('## Top cascade events (2y-1h)');
  for (const e of oneH.topEvents.slice(0, 10)) {
    lines.push(`- ${e.iso} | total=${Math.round(e.totalUsd).toLocaleString()} | longShare=${(e.longShare*100).toFixed(1)}% | z=${e.z.toFixed(2)} | best24h=${pct(e.best24h || 0)} | worst24h=${pct(e.worst24h || 0)}`);
  }
  lines.push('');
  lines.push('## Top cascade events (max-30m)');
  for (const e of thirtyM.topEvents.slice(0, 10)) {
    lines.push(`- ${e.iso} | total=${Math.round(e.totalUsd).toLocaleString()} | longShare=${(e.longShare*100).toFixed(1)}% | z=${e.z.toFixed(2)} | best24h=${pct(e.best24h || 0)} | worst24h=${pct(e.worst24h || 0)}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const dataDir = path.join(process.cwd(), 'data');
  const oneHRows = readCsv(path.join(dataDir, 'coinglass_BTC_liquidation_1h_2y.csv'));
  const thirtyRows = readCsv(path.join(dataDir, 'coinglass_BTC_liquidation_max_30m.csv'));

  const oneHStart = oneHRows[0].timestamp;
  const oneHEnd = oneHRows[oneHRows.length - 1].timestamp;
  const thirtyStart = thirtyRows[0].timestamp;
  const thirtyEnd = thirtyRows[thirtyRows.length - 1].timestamp;

  const [k1h, k30m] = await Promise.all([
    fetchBinanceKlines('1h', oneHStart, oneHEnd),
    fetchBinanceKlines('30m', thirtyStart, thirtyEnd)
  ]);

  const oneH = analyze(oneHRows, k1h, '2y_1h', 1);
  const thirtyM = analyze(thirtyRows, k30m, 'max_30m', 0.5);

  const out = { generatedAt: new Date().toISOString(), oneH, thirtyM };
  await fs.promises.mkdir(path.join(process.cwd(), 'docs'), { recursive: true });
  await fs.promises.writeFile(path.join(process.cwd(), 'docs', 'liquidation-cascade-analysis.json'), JSON.stringify(out, null, 2), 'utf8');
  await fs.promises.writeFile(path.join(process.cwd(), 'docs', 'liquidation-cascade-analysis.md'), buildMarkdown(oneH, thirtyM), 'utf8');
  console.log(JSON.stringify({
    oneH: { bars: oneH.bars, cascades: oneH.cascadeCount, win8: oneH.stats.winRateR8 },
    thirtyM: { bars: thirtyM.bars, cascades: thirtyM.cascadeCount, win8: thirtyM.stats.winRateR8 }
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
