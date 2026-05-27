import AnalysisDashboard from "@/components/analysis-dashboard";
import { analyzeLiquidation, listCsvDatasets, readLiquidationCsv } from "@/lib/data";

export default async function Analysis2Page({ searchParams }) {
  const params = await searchParams;
  const datasets = listCsvDatasets();
  const defaultName = "coinglass_BTC_liquidation_1h_2y.csv";
  const requested = params?.dataset;
  const chosen = (requested && datasets.includes(requested))
    ? requested
    : (datasets.includes(defaultName) ? defaultName : datasets[0]);

  const cascadeOptions = {
    q: Number(params?.q || 0.99),
    minLongShare: Number(params?.minLongShare || 0.8),
    zMin: Number(params?.zMin || 1.5),
    zWindowHours: Number(params?.zWindowHours || 168),
    entryDelayHours: Number(params?.entryDelayHours || 1),
    holdHours: Number(params?.holdHours || 8)
  };

  const rows = chosen ? readLiquidationCsv(chosen) : [];
  const stats = analyzeLiquidation(rows);

  return (
    <AnalysisDashboard
      datasets={datasets}
      chosen={chosen}
      rows={rows}
      stats={stats}
      cascadeOptions={cascadeOptions}
      mode="analysis2"
    />
  );
}
