import type { ThreadUsageRecord } from "@/types/unifiedUsage";
import { safeMetricSum } from "./unifiedUsageData";

export function reportedThreadCounter(
  value: number | null | undefined,
): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Shared lifetime subtotals for the compact summary and detailed thread view. */
export function summarizeThreadUsage(all: ThreadUsageRecord[], accountId = "") {
  const contexts = new Map<string, Set<string>>();
  for (const record of all) {
    if (!record.snapshot) continue;
    const owners = contexts.get(record.threadId) ?? new Set<string>();
    owners.add(record.accountId);
    contexts.set(record.threadId, owners);
  }
  const ambiguous = (record: ThreadUsageRecord) =>
    (contexts.get(record.threadId)?.size ?? 0) > 1;
  const records = all.filter(
    (record) => !accountId || record.accountId === accountId,
  );
  const included = records.filter(
    (record) => record.snapshot && (accountId || !ambiguous(record)),
  );
  const amounts = included
    .map((record) => record.snapshot!.estimatedUsageUsdMicros)
    .filter(reportedThreadCounter);
  const micros = amounts.length ? safeMetricSum(amounts) : null;
  const usd = micros === null ? null : micros / 1_000_000;
  const stale = records.some((record) => record.status !== "available");
  const partial = amounts.length !== records.length || stale;
  const groups = included.flatMap((record) => record.snapshot!.groups);
  // Only explicit totalTokens fields count. Input/output/cache components are
  // never substituted for a missing total, and snapshots never acquire dates.
  const totals = groups
    .map((group) => group.totalTokens)
    .filter(reportedThreadCounter);
  const tokens = totals.length ? safeMetricSum(totals) : null;
  const tokensPartial =
    stale ||
    included.length !== records.length ||
    included.some((record) => !record.snapshot!.groups.length) ||
    totals.length !== groups.length ||
    (totals.length > 0 && tokens === null);
  return {
    records,
    ambiguous,
    usd,
    partial,
    tokens,
    tokensPartial,
    hasAmbiguity: records.some(ambiguous),
  };
}
