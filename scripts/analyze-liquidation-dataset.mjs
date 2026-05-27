import fs from "fs/promises";
import path from "path";

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((s) => s.trim());
  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (!raw) continue;
    const parts = raw.split(",");
    const row = {};
    for (let j = 0; j < headers.length; j += 1) row[headers[j]] = (parts[j] ?? "").trim();
    out.push(row);
  }
  return out;
}

function q(arr, p) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const idx = (a.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function std(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(v);
}

function autocorr(arr, lag) {
  if (arr.length <= lag + 1) return null;
  const x = arr.slice(lag);
  const y = arr.slice(0, arr.length - lag);
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < x.length; i += 1) {
    const a = x[i] - mx;
    const b = y[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

function maxStreak(values, predicate) {
  let best = 0;
  let cur = 0;
  for (const v of values) {
    if (predicate(v)) {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("Usage: node scripts/analyze-liquidation-dataset.mjs <csv_path>");

  const csv = await fs.readFile(inputPath, "utf8");
  const raw = parseCsv(csv);

  const rows = raw
    .map((r) => {
      const ts = Date.parse(r.timestamp ?? r.datetime_utc ?? "");
      const longUsd = safeNum(r.longUsd ?? r.long_liquidations ?? r.long ?? 0);
      const shortUsd = safeNum(r.shortUsd ?? r.short_liquidations ?? r.short ?? 0);
      const totalUsd = Number.isFinite(Number(r.totalUsd ?? r.total_liquidations))
        ? safeNum(r.totalUsd ?? r.total_liquidations)
        : longUsd + shortUsd;
      return { ts, timestamp: new Date(ts).toISOString(), longUsd, shortUsd, totalUsd };
    })
    .filter((r) => Number.isFinite(r.ts))
    .sort((a, b) => a.ts - b.ts);

  if (!rows.length) throw new Error("No valid rows");

  const diffs = [];
  for (let i = 1; i < rows.length; i += 1) diffs.push(rows[i].ts - rows[i - 1].ts);
  const cadenceMs = q(diffs.filter((x) => x > 0), 0.5) ?? 3600000;

  const start = rows[0].ts;
  const end = rows[rows.length - 1].ts;
  const expectedRows = Math.floor((end - start) / cadenceMs) + 1;
  const observedRows = rows.length;
  const missingRows = Math.max(0, expectedRows - observedRows);

  const totals = rows.map((r) => r.totalUsd);
  const longs = rows.map((r) => r.longUsd);
  const shorts = rows.map((r) => r.shortUsd);
  const longShare = rows.map((r) => (r.totalUsd > 0 ? r.longUsd / r.totalUsd : null)).filter((x) => x !== null);

  const gapHours = diffs.map((d) => d / 3600000);
  const missingByGap = gapHours.map((h) => Math.max(0, Math.round(h / (cadenceMs / 3600000)) - 1));

  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0, totalUsd: 0 }));
  const byDow = Array.from({ length: 7 }, (_, d) => ({ dow: d, count: 0, totalUsd: 0 }));
  const byMonth = Array.from({ length: 12 }, (_, m) => ({ month: m + 1, count: 0, totalUsd: 0 }));

  for (const r of rows) {
    const d = new Date(r.ts);
    const h = d.getUTCHours();
    const w = d.getUTCDay();
    const m = d.getUTCMonth();
    byHour[h].count += 1;
    byHour[h].totalUsd += r.totalUsd;
    byDow[w].count += 1;
    byDow[w].totalUsd += r.totalUsd;
    byMonth[m].count += 1;
    byMonth[m].totalUsd += r.totalUsd;
  }

  const topEvents = [...rows]
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, 20)
    .map((r) => ({ timestamp: r.timestamp, longUsd: r.longUsd, shortUsd: r.shortUsd, totalUsd: r.totalUsd }));

  const severityThresholds = {
    p90: q(totals, 0.9) ?? 0,
    p95: q(totals, 0.95) ?? 0,
    p99: q(totals, 0.99) ?? 0,
  };

  const severeByMonth = {};
  for (const r of rows) {
    if (r.totalUsd < severityThresholds.p95) continue;
    const ym = r.timestamp.slice(0, 7);
    severeByMonth[ym] = (severeByMonth[ym] ?? 0) + 1;
  }

  const totalSeriesForAcf = rows.map((r) => Math.log1p(r.totalUsd));

  const report = {
    dataset: path.resolve(inputPath),
    schemaDetected: ["timestamp", "longUsd", "shortUsd", "totalUsd"],
    rangeUtc: {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    },
    cadence: {
      inferredCadenceMs: cadenceMs,
      inferredCadenceHours: cadenceMs / 3600000,
    },
    coverage: {
      observedRows,
      expectedRows,
      missingRows,
      coveragePct: Number(((observedRows / expectedRows) * 100).toFixed(4)),
      longestMissingGapHours: gapHours.length ? Math.max(...gapHours) - cadenceMs / 3600000 : 0,
      medianGapHours: q(gapHours, 0.5) ?? 0,
      p95GapHours: q(gapHours, 0.95) ?? 0,
      estimatedMissingByGaps: missingByGap.reduce((s, x) => s + x, 0),
    },
    liquidationUsd: {
      totalSum: totals.reduce((s, x) => s + x, 0),
      mean: mean(totals),
      median: q(totals, 0.5),
      std: std(totals),
      min: Math.min(...totals),
      p90: severityThresholds.p90,
      p95: severityThresholds.p95,
      p99: severityThresholds.p99,
      max: Math.max(...totals),
      nonZeroCount: totals.filter((x) => x > 0).length,
      zeroCount: totals.filter((x) => x === 0).length,
      nonZeroPct: Number(((totals.filter((x) => x > 0).length / totals.length) * 100).toFixed(4)),
      cv: mean(totals) ? std(totals) / mean(totals) : null,
    },
    sideBias: {
      longSum: longs.reduce((s, x) => s + x, 0),
      shortSum: shorts.reduce((s, x) => s + x, 0),
      longShareMean: mean(longShare),
      longShareMedian: q(longShare, 0.5),
      longDominantHours: rows.filter((r) => r.longUsd > r.shortUsd).length,
      shortDominantHours: rows.filter((r) => r.shortUsd > r.longUsd).length,
      tieHours: rows.filter((r) => r.shortUsd === r.longUsd).length,
    },
    clustering: {
      longestNonZeroStreakRows: maxStreak(totals, (x) => x > 0),
      longestHighStreakRows: maxStreak(totals, (x) => x >= severityThresholds.p95),
      acfLog1p: {
        lag1: autocorr(totalSeriesForAcf, 1),
        lag6: autocorr(totalSeriesForAcf, 6),
        lag24: autocorr(totalSeriesForAcf, 24),
      },
    },
    seasonalityUtc: {
      byHour: byHour.map((x) => ({ ...x, avgUsd: x.count ? x.totalUsd / x.count : 0 })),
      byDayOfWeek: byDow.map((x) => ({ ...x, avgUsd: x.count ? x.totalUsd / x.count : 0 })),
      byMonth: byMonth.map((x) => ({ ...x, avgUsd: x.count ? x.totalUsd / x.count : 0 })),
    },
    severeEvents: {
      thresholds: severityThresholds,
      countAboveP95: rows.filter((r) => r.totalUsd >= severityThresholds.p95).length,
      byMonth: severeByMonth,
      top20: topEvents,
    },
  };

  const base = path.basename(inputPath).replace(/\.(csv|json)$/i, "");
  const outDir = path.join(path.dirname(inputPath), "reports");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${base}.analysis.json`);

  await fs.writeFile(outPath, JSON.stringify(report, null, 2));

  console.log(`Saved report: ${outPath}`);
  console.log(`Coverage: ${report.coverage.observedRows}/${report.coverage.expectedRows} (${report.coverage.coveragePct}%)`);
  console.log(`P95: ${report.liquidationUsd.p95}`);
  console.log(`Max: ${report.liquidationUsd.max}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
