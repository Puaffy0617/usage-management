import { describe, expect, it } from "vitest";
import {
  buildAccountTrend,
  formatAnalyticsTimestamp,
  metricGroupKey,
  safeMetricSum,
  utcRange,
} from "@/components/usage/unifiedUsageData";
import type { DailyAggregate } from "@/types/unifiedUsage";

const row: DailyAggregate = {
  accountId: "A",
  source: "codex_app_server",
  scope: "codex_account_activity",
  metric: "tokens",
  unit: "tokens",
  provenance: "official",
  value: 100,
  date: "2026-11-01",
};

describe("Account analytics metric integrity", () => {
  it("refuses totals outside the supported numeric range", () => {
    expect(safeMetricSum([100, 200])).toBe(300);
    expect(safeMetricSum([Number.MAX_SAFE_INTEGER, 1])).toBeNull();
    expect(safeMetricSum([Infinity])).toBeNull();
    expect(safeMetricSum([NaN])).toBeNull();
  });
  it.each(["source", "scope", "metric", "unit", "provenance"] as const)(
    "never conflates different %s definitions",
    (key) => {
      expect(metricGroupKey({ ...row, [key]: "different" })).not.toBe(
        metricGroupKey(row),
      );
    },
  );

  it("does not fill missing account observations with fabricated zeros", () => {
    const result = buildAccountTrend(
      [
        row,
        { ...row, accountId: "B", date: "2026-11-02", value: 200 },
        { ...row, provenance: "estimated", value: 999 },
      ],
      metricGroupKey(row),
    );
    expect(result).toEqual([
      { date: "2026-11-01", A: 100 },
      { date: "2026-11-02", B: 200 },
    ]);
  });

  it("uses inclusive UTC calendar dates across month boundaries", () => {
    expect(utcRange(7, new Date("2026-11-05T00:30:00+08:00"))).toEqual({
      startDate: "2026-10-29",
      endDate: "2026-11-04",
    });
    expect(utcRange(null)).toEqual({});
  });

  it("keeps a gap when no account reports a day", () => {
    expect(
      buildAccountTrend(
        [row, { ...row, date: "2026-11-03", value: 200 }],
        metricGroupKey(row),
      ),
    ).toEqual([
      { date: "2026-11-01", A: 100 },
      { date: "2026-11-02" },
      { date: "2026-11-03", A: 200 },
    ]);
  });

  it("reads millisecond database timestamps and leaves missing timestamps unknown", () => {
    const timestamp = Date.parse("2026-11-05T00:00:00Z");
    expect(formatAnalyticsTimestamp(timestamp, "en")).toBe(
      new Date(timestamp).toLocaleString("en"),
    );
    expect(formatAnalyticsTimestamp(null, "en")).toBeNull();
  });
});
