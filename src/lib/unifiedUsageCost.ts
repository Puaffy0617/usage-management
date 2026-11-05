import type { UsageBucket } from "@/types/unifiedUsage";
import { isNonNegativeDecimalString, type ModelPricing } from "@/types/usage";

/** A family is an alternative measurement, never an additive data source. */
export interface UsageCostFamily {
  key: string;
  source: string;
  scope: string;
  provenance: string;
  granularity: UsageBucket["granularity"];
  bucketCount: number;
}

export interface UsageCostEstimate {
  usd: number | null;
  cny: number | null;
  partial: boolean;
  pricedBuckets: number;
  unpricedBuckets: number;
  pricedTokens: number | null;
  measuredTokens: number | null;
  measuredTokensPartial: boolean;
  requests: number | null;
  requestsPartial: boolean;
  /** Cached reads / inclusive input, weighted by the measured input counts. */
  cacheHitRate: number | null;
  cacheHitRatePartial: boolean;
  reasons: string[];
}

export interface UnifiedUsageCosts {
  families: UsageCostFamily[];
  familyKey: string | null;
  total: UsageCostEstimate;
  byAccount: Record<string, UsageCostEstimate>;
  byModel: Record<string, UsageCostEstimate>;
  byDay: Record<string, UsageCostEstimate>;
  buckets: {
    key: string;
    bucket: UsageBucket;
    estimate: UsageCostEstimate;
  }[];
}

interface BucketCost {
  usd: number | null;
  tokens: number | null;
  pricedTokens: number;
  requests: number | null;
  input: number | null;
  cacheRead: number | null;
  partial?: boolean;
  reasons: Set<string>;
}

const TOKEN_METRICS = new Set([
  "tokens",
  "total_tokens",
  "input_tokens_total",
  "input_tokens_fresh",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
]);
const REQUEST_METRICS = new Set(["requests", "request_count"]);

export function usageCostFamilyKey(bucket: UsageBucket): string {
  return JSON.stringify([
    bucket.source,
    bucket.scope,
    bucket.provenance,
    bucket.granularity,
  ]);
}

function bucketKey(bucket: UsageBucket): string {
  return JSON.stringify([
    usageCostFamilyKey(bucket),
    bucket.accountId,
    bucket.day,
    bucket.model,
    bucket.platform,
    bucket.feature,
  ]);
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function sumCounts(values: number[]): number | null {
  const sum = values.reduce((total, value) => total + value, 0);
  return validCount(sum) ? sum : null;
}

function equivalent(values: (number | undefined)[]): number | null {
  const present = values.filter(
    (value): value is number => value !== undefined,
  );
  return present.length > 0 && present.every((value) => value === present[0])
    ? present[0]
    : null;
}

function excludedCost(reason: string): BucketCost {
  return {
    usd: null,
    tokens: null,
    pricedTokens: 0,
    requests: null,
    input: null,
    cacheRead: null,
    reasons: new Set([reason]),
  };
}

function priceBucket(
  bucket: UsageBucket,
  prices: Map<string, ModelPricing | null>,
): BucketCost {
  const result = excludedCost("missing_token_breakdown");
  result.reasons.clear();
  const counts = new Map<string, number>();
  let invalidTokens = false;
  let invalidRequests = false;
  let unsupportedTokens = false;
  for (const entry of bucket.metrics) {
    const token = TOKEN_METRICS.has(entry.metric);
    const request = REQUEST_METRICS.has(entry.metric);
    if (entry.metric === "input_tokens") {
      unsupportedTokens = true;
      result.reasons.add("ambiguous_input_tokens");
    } else if (!token && entry.unit === "tokens") {
      unsupportedTokens = true;
      result.reasons.add("unsupported_token_metric");
    }
    if (!token && !request) continue;
    const valid =
      entry.unit === (token ? "tokens" : "requests") &&
      validCount(entry.value) &&
      !counts.has(entry.metric);
    if (!valid) {
      if (token) invalidTokens = true;
      if (request) invalidRequests = true;
      result.reasons.add("invalid_metric");
    } else {
      counts.set(entry.metric, entry.value);
    }
  }
  const get = (metric: string) => counts.get(metric);
  const requests = equivalent([get("requests"), get("request_count")]);
  if (
    get("requests") !== undefined &&
    get("request_count") !== undefined &&
    requests === null
  ) {
    invalidRequests = true;
    result.reasons.add("invalid_metric");
  }
  result.requests = invalidRequests ? null : requests;

  const total = get("input_tokens_total");
  let fresh = get("input_tokens_fresh");
  const output = get("output_tokens");
  const read = get("cache_read_tokens");
  const creation = get("cache_creation_tokens");
  const summary = equivalent([get("tokens"), get("total_tokens")]);
  if (
    get("tokens") !== undefined &&
    get("total_tokens") !== undefined &&
    summary === null
  ) {
    invalidTokens = true;
    result.reasons.add("inconsistent_tokens");
  }
  const componentsInput =
    fresh !== undefined && read !== undefined && creation !== undefined
      ? sumCounts([fresh, read, creation])
      : null;
  if (
    fresh !== undefined &&
    read !== undefined &&
    creation !== undefined &&
    componentsInput === null
  ) {
    invalidTokens = true;
    result.reasons.add("count_overflow");
  }
  if (total !== undefined && read !== undefined && creation !== undefined) {
    const normalized = total - read - creation;
    if (normalized < 0 || (fresh !== undefined && fresh !== normalized)) {
      invalidTokens = true;
      result.reasons.add("inconsistent_tokens");
    } else {
      fresh = normalized;
    }
  }
  const input = total ?? componentsInput;
  if (read !== undefined && input !== null && read > input) {
    invalidTokens = true;
    result.reasons.add("inconsistent_tokens");
  }
  const componentTotal =
    input !== null && output !== undefined ? sumCounts([input, output]) : null;
  if (input !== null && output !== undefined && componentTotal === null) {
    invalidTokens = true;
    result.reasons.add("count_overflow");
  }
  if (
    summary !== null &&
    componentTotal !== null &&
    summary !== componentTotal
  ) {
    invalidTokens = true;
    result.reasons.add("inconsistent_tokens");
  }
  if (!invalidTokens) {
    result.tokens = summary ?? componentTotal;
    result.input = input;
    result.cacheRead = read ?? null;
  }
  if (
    fresh === undefined ||
    output === undefined ||
    read === undefined ||
    creation === undefined
  ) {
    result.reasons.add("missing_token_breakdown");
  }
  const model = bucket.model;
  const pricing = model ? prices.get(model) : undefined;
  if (!model) result.reasons.add("missing_model");
  else if (pricing === undefined) result.reasons.add("missing_price");
  else if (pricing === null) result.reasons.add("invalid_price");
  const rateStrings = pricing && [
    pricing.inputCostPerMillion,
    pricing.outputCostPerMillion,
    pricing.cacheReadCostPerMillion,
    pricing.cacheCreationCostPerMillion,
  ];
  const rates = rateStrings?.every(
    (value) =>
      typeof value === "string" &&
      isNonNegativeDecimalString(value) &&
      (Number(value) > 0 || !/[1-9]/.test(value)),
  )
    ? rateStrings.map(Number)
    : null;
  if (pricing && rates === null) result.reasons.add("invalid_price");
  if (
    invalidTokens ||
    unsupportedTokens ||
    fresh === undefined ||
    output === undefined ||
    read === undefined ||
    creation === undefined ||
    componentTotal === null ||
    rates === null
  ) {
    return result;
  }
  // Standard configured rates only. A daily aggregate is not a request's
  // context length and cannot establish long-context or cache-duration tiers.
  const usd =
    (fresh * rates[0] +
      output * rates[1] +
      read * rates[2] +
      creation * rates[3]) /
    1_000_000;
  if (
    usd === 0 &&
    [fresh, output, read, creation].some(
      (count, index) => count > 0 && rates[index] > 0,
    )
  ) {
    result.reasons.add("invalid_price");
    return result;
  }
  if (!Number.isFinite(usd) || usd > Number.MAX_SAFE_INTEGER) {
    result.reasons.add("count_overflow");
    return result;
  }
  result.usd = usd;
  result.pricedTokens = componentTotal;
  return result;
}

/** Unknown daily dimensions may be a total covering the named partitions. */
function excludedBuckets(buckets: UsageBucket[]): {
  excluded: Map<number, string>;
  partial: Set<number>;
} {
  const excluded = new Map<number, string>();
  const partial = new Set<number>();
  const exact = new Map<string, number[]>();
  const groups = new Map<string, number[]>();
  const append = (map: Map<string, number[]>, key: string, index: number) => {
    const group = map.get(key) ?? [];
    group.push(index);
    map.set(key, group);
  };
  buckets.forEach((bucket, index) => {
    append(exact, bucketKey(bucket), index);
    if (bucket.granularity !== "event") {
      append(groups, JSON.stringify([bucket.accountId, bucket.day]), index);
    }
  });
  for (const indices of exact.values()) {
    if (indices.length > 1) {
      indices.forEach((index) => excluded.set(index, "duplicate_bucket"));
    }
  }
  for (const indices of groups.values()) {
    if (indices.length < 2) continue;
    // Eight known/unknown patterns for model/platform/feature. Compare only
    // dimensions known on both rows. This avoids a quadratic all-pairs scan.
    const patterns = new Map<number, number[]>();
    const dimensions = (index: number) => {
      const row = buckets[index];
      return [row.model, row.platform, row.feature];
    };
    for (const index of indices) {
      const mask = dimensions(index).reduce<number>(
        (known, value, bit) => known | (value ? 1 << bit : 0),
        0,
      );
      const rows = patterns.get(mask) ?? [];
      rows.push(index);
      patterns.set(mask, rows);
    }
    const mark = (items: number[]) =>
      items.forEach((index) => {
        if (!excluded.has(index)) excluded.set(index, "overlapping_dimensions");
      });
    const entries = [...patterns];
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left; right < entries.length; right += 1) {
        const [leftMask, leftRows] = entries[left];
        const [rightMask, rightRows] = entries[right];
        const shared = leftMask & rightMask;
        const projection = (index: number) =>
          JSON.stringify(
            dimensions(index).filter((_, bit) => (shared & (1 << bit)) !== 0),
          );
        const projected = new Map<string, number[]>();
        leftRows.forEach((index) =>
          append(projected, projection(index), index),
        );
        if (left === right) {
          for (const rows of projected.values())
            if (rows.length > 1) mark(rows);
          continue;
        }
        const differentModelCoverage =
          Boolean(leftMask & 1) !== Boolean(rightMask & 1);
        const markCompatible = (rows: number[], mask: number) => {
          // Model-less summaries may cover these named details. Retain only
          // the known-model subtotal, explicitly marked as partial coverage.
          // Ambiguities between named platform/feature rows still exclude both.
          if (differentModelCoverage && mask & 1) {
            rows.forEach((index) => partial.add(index));
          } else mark(rows);
        };
        const matched = new Set<string>();
        for (const index of rightRows) {
          const key = projection(index);
          if (projected.has(key)) {
            matched.add(key);
            markCompatible([index], rightMask);
          }
        }
        for (const key of matched)
          markCompatible(projected.get(key)!, leftMask);
      }
    }
  }
  return { excluded, partial };
}

function aggregate(
  costs: BucketCost[],
  usdToCny?: number | null,
): UsageCostEstimate {
  const reasons = new Set(costs.flatMap((cost) => [...cost.reasons]));
  const priced = costs.filter((cost) => cost.usd !== null);
  const addKnown = (values: (number | null)[]): number | null => {
    const present = values.filter((value): value is number => value !== null);
    if (present.length === 0) return null;
    const sum = sumCounts(present);
    if (sum === null) reasons.add("count_overflow");
    return sum;
  };
  let usd = priced.length
    ? priced.reduce((sum, cost) => sum + cost.usd!, 0)
    : null;
  if (
    usd !== null &&
    (!Number.isFinite(usd) || usd > Number.MAX_SAFE_INTEGER)
  ) {
    usd = null;
    reasons.add("count_overflow");
  }
  let cny: number | null = null;
  if (usd !== null) {
    if (
      typeof usdToCny === "number" &&
      Number.isFinite(usdToCny) &&
      usdToCny > 0
    ) {
      const converted = usd * usdToCny;
      if (
        Number.isFinite(converted) &&
        converted <= Number.MAX_SAFE_INTEGER &&
        (converted > 0 || usd === 0)
      ) {
        cny = converted;
      } else reasons.add("count_overflow");
    } else reasons.add("missing_exchange_rate");
  }
  const measuredTokens = addKnown(costs.map((cost) => cost.tokens));
  const requests = addKnown(costs.map((cost) => cost.requests));
  const cacheKnown = costs.filter(
    (cost) => cost.input !== null && cost.cacheRead !== null,
  );
  const input = addKnown(cacheKnown.map((cost) => cost.input));
  const cacheRead = addKnown(cacheKnown.map((cost) => cost.cacheRead));
  const pricedTokens = addKnown(priced.map((cost) => cost.pricedTokens));
  return {
    usd,
    cny,
    partial:
      costs.length !== priced.length ||
      costs.some((cost) => cost.partial) ||
      (priced.length > 0 && usd === null),
    pricedBuckets: priced.length,
    unpricedBuckets: costs.length - priced.length,
    pricedTokens: priced.length === 0 ? 0 : pricedTokens,
    measuredTokens,
    measuredTokensPartial:
      costs.some((cost) => cost.tokens === null || cost.partial) ||
      (costs.length > 0 && measuredTokens === null),
    requests,
    requestsPartial:
      costs.some((cost) => cost.requests === null || cost.partial) ||
      (costs.length > 0 && requests === null),
    cacheHitRate:
      input !== null && input > 0 && cacheRead !== null
        ? cacheRead / input
        : null,
    cacheHitRatePartial:
      cacheKnown.length !== costs.length ||
      costs.some((cost) => cost.partial) ||
      (cacheKnown.length > 0 && input === null),
    reasons: [...reasons].sort(),
  };
}

/** API-equivalent estimate, never a subscription bill or monetary quota. */
export function estimateUnifiedUsageCosts(
  buckets: UsageBucket[],
  pricing: ModelPricing[],
  options: { familyKey?: string | null; usdToCny?: number | null } = {},
): UnifiedUsageCosts {
  const families = new Map<string, UsageCostFamily>();
  for (const bucket of buckets) {
    const key = usageCostFamilyKey(bucket);
    const family = families.get(key);
    if (family) family.bucketCount += 1;
    else
      families.set(key, {
        key,
        source: bucket.source,
        scope: bucket.scope,
        provenance: bucket.provenance,
        granularity: bucket.granularity,
        bucketCount: 1,
      });
  }
  const requested = options.familyKey;
  const selected =
    requested && families.has(requested)
      ? requested
      : !requested && families.size === 1
        ? families.keys().next().value!
        : null;
  const empty = aggregate([], options.usdToCny);
  if (selected === null) {
    if (buckets.length > 0) {
      empty.partial = true;
      empty.measuredTokensPartial = true;
      empty.requestsPartial = true;
      empty.cacheHitRatePartial = true;
      empty.reasons.push(requested ? "unknown_family" : "select_family");
    }
    return {
      families: [...families.values()],
      familyKey: null,
      total: empty,
      byAccount: {},
      byModel: {},
      byDay: {},
      buckets: [],
    };
  }
  const selectedBuckets = buckets.filter(
    (bucket) => usageCostFamilyKey(bucket) === selected,
  );
  const prices = new Map<string, ModelPricing | null>();
  for (const price of pricing) {
    prices.set(price.modelId, prices.has(price.modelId) ? null : price);
  }
  const { excluded, partial } = excludedBuckets(selectedBuckets);
  const costs = selectedBuckets.map((bucket, index) => {
    const reason = excluded.get(index);
    const cost = reason ? excludedCost(reason) : priceBucket(bucket, prices);
    if (partial.has(index)) {
      cost.partial = true;
      cost.reasons.add("overlapping_dimensions");
    }
    return cost;
  });
  const group = (key: (bucket: UsageBucket) => string | null) => {
    const groups = new Map<string, BucketCost[]>();
    selectedBuckets.forEach((bucket, index) => {
      const value = key(bucket);
      if (value === null) return;
      const rows = groups.get(value) ?? [];
      rows.push(costs[index]);
      groups.set(value, rows);
    });
    return Object.fromEntries(
      [...groups].map(([name, rows]) => [
        name,
        aggregate(rows, options.usdToCny),
      ]),
    );
  };
  return {
    families: [...families.values()],
    familyKey: selected,
    total: aggregate(costs, options.usdToCny),
    byAccount: group((bucket) => bucket.accountId),
    byModel: group((bucket) => bucket.model ?? ""),
    byDay: group((bucket) =>
      bucket.granularity === "lifetime" ? null : bucket.day,
    ),
    buckets: selectedBuckets.map((bucket, index) => ({
      key: bucketKey(bucket),
      bucket,
      estimate: aggregate([costs[index]], options.usdToCny),
    })),
  };
}
