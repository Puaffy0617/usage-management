export interface AnalyticsAccount {
  id: string;
  name: string;
  identity: string | null;
  subscription: string | null;
  connectionStatus: string;
  lastSyncAt: number | null;
  lastError: string | null;
  syncIntervalMinutes: number;
  summary: Record<string, unknown> | null;
  quota: Record<string, unknown> | null;
  quotaUpdatedAt: number | null;
  createdAt: number;
  /** Existing CC Switch session linked by reference; never its credentials. */
  linkedAccountId?: string | null;
}

export interface AnalyticsFilter {
  startDate?: string;
  endDate?: string;
  accountIds?: string[];
  model?: string;
  platform?: string;
  feature?: string;
  provenance?: string;
}

export interface MetricAggregate {
  accountId: string;
  source: string;
  scope: string;
  metric: string;
  unit: string;
  provenance: string;
  value: number;
}

export interface DailyAggregate extends MetricAggregate {
  date: string;
}

export interface AnalyticsBreakdown extends MetricAggregate {
  dimension: "model" | "platform" | "feature";
  label: string;
}

export interface AnalyticsSyncRun {
  id: string;
  accountId: string;
  source: string;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  imported: number;
  error: string | null;
}

export interface AnalyticsDashboard {
  accounts: AnalyticsAccount[];
  totals: MetricAggregate[];
  daily: DailyAggregate[];
  breakdowns: AnalyticsBreakdown[];
  recordCount: number;
  syncHistory: AnalyticsSyncRun[];
  /** Complete filtered dimension intersections; older fixtures may omit it. */
  usageBuckets?: UsageBucket[];
}

export interface UsageBucketMetric {
  metric: string;
  unit: string;
  value: number;
}

export interface UsageBucket {
  accountId: string;
  source: string;
  scope: string;
  provenance: string;
  granularity: "day" | "event" | "lifetime";
  /** UTC date; null is reserved for genuinely reported lifetime-only sources. */
  day: string | null;
  model: string | null;
  platform: string | null;
  feature: string | null;
  /** Omitted components stay unavailable; generic input_tokens is ambiguous. */
  metrics: UsageBucketMetric[];
}

export interface AnalyticsLogin {
  loginId: string;
  authUrl: string;
  type: string;
}

export type AnalyticsImportFormat =
  | "backup"
  | "chatgpt_export"
  | "observations";

export interface ThreadUsageGroup {
  model: string | null;
  reasoningEffort: string | null;
  speed: string | null;
  estimatedUsageCreditsMicros: number;
  netNewInputTokens: number | null;
  cachedInputTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

/** Official thread lifetime snapshot; it has no reported activity date. */
export interface ThreadUsageSnapshot {
  threadId: string;
  day: null;
  estimatedUsageCreditsMicros: number;
  estimatedUsageUsdMicros: number | null;
  nativeUsageUsdMicros: number | null;
  groups: ThreadUsageGroup[];
}

export interface ThreadUsageRecord {
  accountId: string;
  threadId: string;
  status: "available" | "unavailable" | "error";
  checkedAt: number;
  lastSuccessAt: number | null;
  snapshot: ThreadUsageSnapshot | null;
  error: string | null;
}

export interface ThreadUsageDashboard {
  records: ThreadUsageRecord[];
  candidateCount: number;
}
