import fs from "fs";
import path from "path";

export function readDataset() {
  const file = path.join(process.cwd(), "data", "btc_liquidation_2y.json");
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf-8");
  return JSON.parse(raw);
}

export function summarize(data) {
  if (!data.length) return { rows: 0, longUsd: 0, maxLongUsd: 0 };
  const rows = data.length;
  const longUsd = data.reduce((acc, d) => acc + Number(d.longUsd || 0), 0);
  const maxLongUsd = Math.max(...data.map((d) => Number(d.longUsd || 0)));
  return { rows, longUsd, maxLongUsd };
}

export function listCsvDatasets() {
  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir)
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .sort();
}

export function readLiquidationCsv(fileName) {
  const file = path.join(process.cwd(), "data", fileName);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf-8").trim();
  if (!raw) return [];

  const lines = raw.split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((s) => s.trim());

  const hTs = headers.find((h) => ["timestamp", "time", "ts"].includes(h));
  const hDatetime = headers.find((h) => ["datetime_utc", "datetime", "date", "time_iso"].includes(h));
  const hLong = headers.find((h) => ["longUsd", "long_liquidations", "long"].includes(h));
  const hShort = headers.find((h) => ["shortUsd", "short_liquidations", "short"].includes(h));
  const hTotal = headers.find((h) => ["totalUsd", "total_liquidations", "total"].includes(h));

  return lines.slice(1).map((line) => {
    const parts = line.split(",");
    const obj = Object.fromEntries(headers.map((h, i) => [h, parts[i] ?? ""]));
    const rawTs = hTs ? String(obj[hTs] || "").trim() : "";
    const rawDatetime = hDatetime ? String(obj[hDatetime] || "").trim() : "";

    let ts = Number.NaN;
    if (rawTs) {
      const n = Number(rawTs);
      if (Number.isFinite(n) && n > 0) {
        ts = n > 1e12 ? n : n * 1000;
      } else {
        const parsed = Date.parse(rawTs);
        if (Number.isFinite(parsed)) ts = parsed;
      }
    }
    if (!Number.isFinite(ts) && rawDatetime) {
      const parsed = Date.parse(rawDatetime);
      if (Number.isFinite(parsed)) ts = parsed;
    }

    const longUsd = Number(obj[hLong] || 0) || 0;
    const shortUsd = Number(obj[hShort] || 0) || 0;
    const totalUsd = hTotal ? (Number(obj[hTotal] || 0) || 0) : longUsd + shortUsd;
    return {
      timestamp: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
      ts,
      longUsd,
      shortUsd,
      totalUsd
    };
  }).filter((r) => Number.isFinite(r.ts)).sort((a, b) => a.ts - b.ts);
}

function quantile(arr, p) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const idx = (a.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

export function analyzeLiquidation(rows) {
  if (!rows.length) {
    return {
      summary: { rows: 0, coveragePct: 0, rangeStart: null, rangeEnd: null, p95: 0, max: 0 },
      topEvents: [],
      topGaps: [],
      byMonth: [],
      byHour: [],
      byWeekday: [],
      distribution: [],
      insights: []
    };
  }

  const totals = rows.map((r) => r.totalUsd);
  const longTotal = rows.reduce((s, r) => s + r.longUsd, 0);
  const shortTotal = rows.reduce((s, r) => s + r.shortUsd, 0);
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const h = (rows[i].ts - rows[i - 1].ts) / 3600000;
    if (h > 1) gaps.push({ from: rows[i - 1].timestamp, to: rows[i].timestamp, missingHours: Math.round(h - 1), gapHours: h });
  }
  gaps.sort((a, b) => b.missingHours - a.missingHours);

  const start = rows[0].ts;
  const end = rows[rows.length - 1].ts;
  const expected = Math.floor((end - start) / 3600000) + 1;
  const coveragePct = expected > 0 ? (rows.length / expected) * 100 : 0;

  const byMonthMap = new Map();
  const byHourMap = new Map();
  const byWeekdayMap = new Map();
  for (const r of rows) {
    const d = new Date(r.ts);
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const h = d.getUTCHours();
    const weekday = d.getUTCDay();
    byMonthMap.set(ym, (byMonthMap.get(ym) || 0) + 1);
    const curr = byHourMap.get(h) || { hour: h, count: 0, totalUsd: 0 };
    curr.count += 1;
    curr.totalUsd += r.totalUsd;
    byHourMap.set(h, curr);
    const w = byWeekdayMap.get(weekday) || { weekday, count: 0, totalUsd: 0 };
    w.count += 1;
    w.totalUsd += r.totalUsd;
    byWeekdayMap.set(weekday, w);
  }

  const byMonth = [];
  let cursor = new Date(start);
  cursor.setUTCMinutes(0, 0, 0);
  cursor.setUTCDate(1);
  const finalMonth = new Date(end);
  finalMonth.setUTCMinutes(0, 0, 0);
  finalMonth.setUTCDate(1);

  while (cursor <= finalMonth) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth();
    const key = `${y}-${String(m + 1).padStart(2, "0")}`;
    const monthStart = Date.UTC(y, m, 1, 0, 0, 0);
    const monthEnd = Date.UTC(y, m + 1, 1, 0, 0, 0) - 1;
    const from = Math.max(start, monthStart);
    const to = Math.min(end, monthEnd);
    const expectedMonth = from <= to ? Math.floor((to - from) / 3600000) + 1 : 0;
    const observedMonth = byMonthMap.get(key) || 0;
    byMonth.push({
      month: key,
      observed: observedMonth,
      expected: expectedMonth,
      coveragePct: expectedMonth > 0 ? (observedMonth / expectedMonth) * 100 : 0
    });
    cursor = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0));
  }

  const byHour = Array.from(byHourMap.values())
    .map((x) => ({ ...x, avgUsd: x.count ? x.totalUsd / x.count : 0 }))
    .sort((a, b) => b.avgUsd - a.avgUsd);
  const byWeekday = Array.from({ length: 7 }, (_, weekday) => {
    const x = byWeekdayMap.get(weekday) || { count: 0, totalUsd: 0 };
    return { weekday, count: x.count, totalUsd: x.totalUsd, avgUsd: x.count ? x.totalUsd / x.count : 0 };
  }).sort((a, b) => b.avgUsd - a.avgUsd);

  const p50 = quantile(totals, 0.5);
  const p90 = quantile(totals, 0.9);
  const p95 = quantile(totals, 0.95);
  const p99 = quantile(totals, 0.99);

  const distribution = [
    { label: "<= P50", count: totals.filter((x) => x <= p50).length },
    { label: "P50 - P90", count: totals.filter((x) => x > p50 && x <= p90).length },
    { label: "P90 - P95", count: totals.filter((x) => x > p90 && x <= p95).length },
    { label: "P95 - P99", count: totals.filter((x) => x > p95 && x <= p99).length },
    { label: "> P99", count: totals.filter((x) => x > p99).length }
  ];

  const longestGap = gaps[0] || null;
  const bestHour = byHour[0] || null;
  const bestWeekday = byWeekday[0] || null;
  const insights = [
    `Coverage hien tai ${coveragePct.toFixed(2)}%, du lieu bi thieu theo tung cum gap lon.`,
    longestGap ? `Gap lon nhat: ${longestGap.missingHours} gio lien tuc (${longestGap.from} -> ${longestGap.to}).` : "Khong co gap lon hon 1 gio.",
    `Long/Short tong: $${Math.round(longTotal).toLocaleString()} / $${Math.round(shortTotal).toLocaleString()}.`,
    bestHour ? `Khung gio UTC co liquidation trung binh cao nhat: ${String(bestHour.hour).padStart(2, "0")}:00.` : "Khong du du lieu de xac dinh khung gio uu the.",
    bestWeekday ? `Thu UTC co liquidation trung binh cao nhat: ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][bestWeekday.weekday]}.` : "Khong du du lieu de xac dinh ngay uu the."
  ];

  return {
    summary: {
      rows: rows.length,
      expectedRows: expected,
      coveragePct,
      rangeStart: new Date(start).toISOString(),
      rangeEnd: new Date(end).toISOString(),
      totalUsd: totals.reduce((s, x) => s + x, 0),
      avgUsd: totals.reduce((s, x) => s + x, 0) / totals.length,
      medianUsd: p50,
      p90,
      p95,
      p99,
      max: Math.max(...totals),
      longTotal,
      shortTotal,
      longSharePct: (longTotal / (longTotal + shortTotal || 1)) * 100
    },
    topEvents: [...rows].sort((a, b) => b.totalUsd - a.totalUsd).slice(0, 12),
    topGaps: gaps.slice(0, 12),
    byMonth,
    byHour,
    byWeekday,
    distribution,
    insights
  };
}
