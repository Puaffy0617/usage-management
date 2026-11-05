import type { DailyAggregate, MetricAggregate } from "@/types/unifiedUsage";

/** Only identical scopes and metric definitions may share a total or chart. */
export function metricGroupKey(row: MetricAggregate): string {
  return JSON.stringify([
    row.source,
    row.scope,
    row.metric,
    row.unit,
    row.provenance,
  ]);
}

export function safeMetricSum(values: number[]): number | null {
  let total = 0;
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0) return null;
    total += value;
    if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) return null;
  }
  return total;
}

export function buildAccountTrend(
  rows: DailyAggregate[],
  group: string,
): Record<string, string | number>[] {
  const dates = new Map<string, Record<string, string | number>>();
  for (const row of rows) {
    if (metricGroupKey(row) !== group) continue;
    const date = dates.get(row.date) ?? { date: row.date };
    date[row.accountId] = Number(date[row.accountId] ?? 0) + row.value;
    dates.set(row.date, date);
  }
  const keys = [...dates.keys()].sort();
  if (!keys.length) return [];
  const result: Record<string, string | number>[] = [];
  const cursor = new Date(`${keys[0]}T00:00:00Z`);
  const last = keys[keys.length - 1];
  while (cursor.toISOString().slice(0, 10) <= last) {
    const date = cursor.toISOString().slice(0, 10);
    // Explicit missing days stop the chart from drawing a line over an unknown
    // interval. Values stay absent: an unknown day is never a zero-use day.
    result.push(dates.get(date) ?? { date });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

export function utcRange(days: number | null, now = new Date()) {
  if (days === null) return {};
  const endDate = now.toISOString().slice(0, 10);
  const start = new Date(`${endDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { startDate: start.toISOString().slice(0, 10), endDate };
}

export function formatAnalyticsTimestamp(
  timestamp: number | null,
  locale: string,
) {
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(locale);
}
