import { describe, expect, it } from "vitest";
import {
  estimateUnifiedUsageCosts,
  usageCostFamilyKey,
} from "@/lib/unifiedUsageCost";
import type { UsageBucket, UsageBucketMetric } from "@/types/unifiedUsage";
import type { ModelPricing } from "@/types/usage";

const prices: ModelPricing[] = [
  {
    modelId: "model-a",
    displayName: "Model A",
    inputCostPerMillion: "2",
    outputCostPerMillion: "10",
    cacheReadCostPerMillion: "0.1",
    cacheCreationCostPerMillion: "2.5",
  },
  {
    modelId: "model-b",
    displayName: "Model B",
    inputCostPerMillion: "5",
    outputCostPerMillion: "20",
    cacheReadCostPerMillion: "0.5",
    cacheCreationCostPerMillion: "6",
  },
];

const metric = (
  name: string,
  value: number,
  unit = "tokens",
): UsageBucketMetric => ({ metric: name, unit, value });

function bucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    accountId: "account-a",
    source: "structured_import",
    scope: "declared-scope",
    provenance: "imported",
    granularity: "day",
    day: "2026-11-05",
    model: "model-a",
    platform: "cli",
    feature: "assistant",
    metrics: [
      metric("input_tokens_total", 1000),
      metric("output_tokens", 200),
      metric("cache_read_tokens", 400),
      metric("cache_creation_tokens", 100),
      metric("requests", 2, "requests"),
    ],
    ...overrides,
  };
}

describe("API-equivalent usage costs", () => {
  it("subtracts cached input once and prices all components at configured rates", () => {
    const result = estimateUnifiedUsageCosts([bucket()], prices, {
      usdToCny: 6,
    });
    expect(result.total.usd).toBeCloseTo(0.00329, 10);
    expect(result.total.cny).toBeCloseTo(0.01974, 10);
    expect(result.total).toMatchObject({
      partial: false,
      measuredTokens: 1200,
      pricedTokens: 1200,
      requests: 2,
      cacheHitRate: 0.4,
      pricedBuckets: 1,
      unpricedBuckets: 0,
      measuredTokensPartial: false,
      requestsPartial: false,
      cacheHitRatePartial: false,
    });
  });

  it("supports explicit fresh input and does not double-count a matching total", () => {
    const item = bucket();
    item.metrics.push(
      metric("input_tokens_fresh", 500),
      metric("total_tokens", 1200),
    );
    const inclusive = estimateUnifiedUsageCosts([item], prices).total;
    item.metrics = item.metrics.filter(
      (entry) => entry.metric !== "input_tokens_total",
    );
    const fresh = estimateUnifiedUsageCosts([item], prices).total;
    expect(fresh.usd).toBeCloseTo(inclusive.usd!, 10);
    expect(fresh.measuredTokens).toBe(1200);
    expect(fresh.cacheHitRate).toBe(0.4);
  });

  it("prices each exact model and aggregates both accounts, days and models", () => {
    const onlyInput = [
      metric("input_tokens_fresh", 1_000_000),
      metric("output_tokens", 0),
      metric("cache_read_tokens", 0),
      metric("cache_creation_tokens", 0),
    ];
    const result = estimateUnifiedUsageCosts(
      [
        bucket({ metrics: onlyInput }),
        bucket({
          accountId: "account-b",
          model: "model-b",
          day: "2026-11-06",
          metrics: onlyInput,
        }),
      ],
      prices,
      { usdToCny: 7 },
    );
    expect(result.total.usd).toBe(7);
    expect(result.total.cny).toBe(49);
    expect(result.total.measuredTokens).toBe(2_000_000);
    expect(result.byAccount["account-a"].usd).toBe(2);
    expect(result.byAccount["account-b"].usd).toBe(5);
    expect(result.byModel["model-b"].usd).toBe(5);
    expect(result.byDay["2026-11-05"].usd).toBe(2);
    expect(result.buckets[1].estimate.usd).toBe(5);
  });

  it("applies no per-request long-context surcharge to a large daily aggregate", () => {
    const item = bucket({
      metrics: [
        metric("input_tokens_fresh", 10_000_000),
        metric("output_tokens", 0),
        metric("cache_read_tokens", 0),
        metric("cache_creation_tokens", 0),
      ],
    });
    expect(estimateUnifiedUsageCosts([item], prices).total.usd).toBe(20);
  });

  it("preserves a manual catalog override and exact model identity", () => {
    const custom = [{ ...prices[0], inputCostPerMillion: "12" }];
    expect(estimateUnifiedUsageCosts([bucket()], custom).total.usd).toBeCloseTo(
      0.00829,
    );
    expect(
      estimateUnifiedUsageCosts([bucket({ model: "provider/model-a" })], prices)
        .total,
    ).toMatchObject({ usd: null, reasons: ["missing_price"] });
  });

  it("distinguishes explicit measured zero from unavailable usage", () => {
    const zero = bucket({
      metrics: [
        metric("input_tokens_total", 0),
        metric("output_tokens", 0),
        metric("cache_read_tokens", 0),
        metric("cache_creation_tokens", 0),
        metric("requests", 0, "requests"),
      ],
    });
    expect(
      estimateUnifiedUsageCosts([zero], prices, { usdToCny: 7 }).total,
    ).toMatchObject({
      usd: 0,
      cny: 0,
      partial: false,
      measuredTokens: 0,
      requests: 0,
      cacheHitRate: null,
    });
    expect(
      estimateUnifiedUsageCosts([bucket({ metrics: [] })], prices).total,
    ).toMatchObject({
      usd: null,
      cny: null,
      measuredTokens: null,
      requests: null,
      partial: true,
    });
  });

  it("retains a clearly partial priced subtotal with unpriced model usage", () => {
    const result = estimateUnifiedUsageCosts(
      [bucket(), bucket({ accountId: "account-b", model: "not-in-catalog" })],
      prices,
      { usdToCny: 6 },
    );
    expect(result.total).toMatchObject({
      partial: true,
      pricedBuckets: 1,
      unpricedBuckets: 1,
      measuredTokens: 2400,
      measuredTokensPartial: false,
      pricedTokens: 1200,
    });
    expect(result.total.usd).toBeCloseTo(0.00329);
    expect(result.byAccount["account-b"].usd).toBeNull();
    expect(result.byAccount["account-b"].reasons).toContain("missing_price");
  });

  it.each([undefined, null, 0, -1, NaN, Infinity])(
    "does not invent CNY for unavailable FX %s",
    (usdToCny) => {
      const total = estimateUnifiedUsageCosts([bucket()], prices, {
        usdToCny,
      }).total;
      expect(total.usd).toBeCloseTo(0.00329);
      expect(total.cny).toBeNull();
      expect(total.reasons).toContain("missing_exchange_rate");
    },
  );

  it("does not infer missing cache creation as zero", () => {
    const item = bucket();
    item.metrics = item.metrics.filter(
      (entry) => entry.metric !== "cache_creation_tokens",
    );
    const total = estimateUnifiedUsageCosts([item], prices).total;
    expect(total).toMatchObject({
      usd: null,
      measuredTokens: 1200,
      cacheHitRate: 0.4,
    });
    expect(total.reasons).toContain("missing_token_breakdown");
  });

  it("does not round a positive CNY conversion into zero", () => {
    const total = estimateUnifiedUsageCosts([bucket()], prices, {
      usdToCny: Number.MIN_VALUE,
    }).total;
    expect(total.usd).toBeGreaterThan(0);
    expect(total.cny).toBeNull();
    expect(total.reasons).toContain("count_overflow");
  });

  it("leaves generic input semantics, unknown token metrics and model-less totals unpriced", () => {
    const generic = bucket();
    generic.metrics = generic.metrics.map((entry) =>
      entry.metric === "input_tokens_total"
        ? { ...entry, metric: "input_tokens" }
        : entry,
    );
    expect(
      estimateUnifiedUsageCosts([generic], prices).total.reasons,
    ).toContain("ambiguous_input_tokens");
    const extra = bucket();
    extra.metrics.push(metric("reasoning_tokens", 10));
    expect(estimateUnifiedUsageCosts([extra], prices).total).toMatchObject({
      usd: null,
      measuredTokens: 1200,
    });
    const official = bucket({ model: null, metrics: [metric("tokens", 42)] });
    const total = estimateUnifiedUsageCosts([official], prices).total;
    expect(total).toMatchObject({
      usd: null,
      measuredTokens: 42,
      requests: null,
      cacheHitRate: null,
    });
    expect(total.reasons).toContain("missing_model");
  });

  it("does not treat quota percentages, credit balances or messages as USD or requests", () => {
    const total = estimateUnifiedUsageCosts(
      [
        bucket({
          metrics: [
            metric("quota_used_percent", 20, "percent"),
            metric("credit_balance", 45, "credits"),
            metric("user_messages", 8, "messages"),
          ],
        }),
      ],
      prices,
    ).total;
    expect(total).toMatchObject({
      usd: null,
      measuredTokens: null,
      requests: null,
    });
  });

  it("rejects malformed prices, duplicated catalog IDs and invalid counters", () => {
    for (const inputCostPerMillion of ["2oops", "-1", "Infinity", "1e3", ""]) {
      const total = estimateUnifiedUsageCosts(
        [bucket()],
        [{ ...prices[0], inputCostPerMillion }],
      ).total;
      expect(total.usd).toBeNull();
      expect(total.reasons).toContain("invalid_price");
    }
    expect(
      estimateUnifiedUsageCosts([bucket()], [prices[0], prices[0]]).total.usd,
    ).toBeNull();
    for (const value of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const item = bucket();
      item.metrics[0] = metric("input_tokens_total", value);
      expect(estimateUnifiedUsageCosts([item], prices).total).toMatchObject({
        usd: null,
        measuredTokens: null,
      });
    }
    const wrongUnit = bucket();
    wrongUnit.metrics[0].unit = "credits";
    expect(estimateUnifiedUsageCosts([wrongUnit], prices).total.usd).toBeNull();
  });

  it("does not round positive underflowing prices into free usage", () => {
    for (const inputCostPerMillion of [
      "0." + "0".repeat(324) + "1",
      "0." + "0".repeat(322) + "1",
    ]) {
      const total = estimateUnifiedUsageCosts(
        [
          bucket({
            metrics: [
              metric("input_tokens_fresh", 1),
              metric("output_tokens", 0),
              metric("cache_read_tokens", 0),
              metric("cache_creation_tokens", 0),
            ],
          }),
        ],
        [{ ...prices[0], inputCostPerMillion }],
      ).total;
      expect(total.usd).toBeNull();
      expect(total.reasons).toContain("invalid_price");
    }
  });

  it("rejects inconsistent totals and cache normalization instead of saturating them", () => {
    const scenarios = [
      [metric("input_tokens_fresh", 999)],
      [metric("total_tokens", 1500)],
      [metric("tokens", 1200), metric("total_tokens", 1300)],
      [metric("input_tokens_total", 1000)], // duplicate counter, not another partition
    ];
    for (const additions of scenarios) {
      const item = bucket();
      item.metrics.push(...additions);
      expect(estimateUnifiedUsageCosts([item], prices).total).toMatchObject({
        usd: null,
        measuredTokens: null,
      });
    }
    const negative = bucket();
    negative.metrics[0].value = 100;
    expect(
      estimateUnifiedUsageCosts([negative], prices).total.reasons,
    ).toContain("inconsistent_tokens");
  });

  it("weights cache hits by input volume and marks incomplete measured subtotals", () => {
    const second = bucket({
      accountId: "account-b",
      metrics: [
        metric("input_tokens_total", 9000),
        metric("output_tokens", 0),
        metric("cache_read_tokens", 100),
        metric("cache_creation_tokens", 0),
      ],
    });
    const result = estimateUnifiedUsageCosts([bucket(), second], prices).total;
    expect(result.cacheHitRate).toBe(0.05);
    expect(result.requests).toBe(2);
    expect(result.requestsPartial).toBe(true);
    const partial = estimateUnifiedUsageCosts(
      [bucket(), bucket({ accountId: "account-b", metrics: [] })],
      prices,
    ).total;
    expect(partial).toMatchObject({
      measuredTokens: 1200,
      measuredTokensPartial: true,
      cacheHitRate: 0.4,
      cacheHitRatePartial: true,
    });
  });

  it("uses request aliases once and rejects disagreements", () => {
    const item = bucket();
    item.metrics.push(metric("request_count", 2, "requests"));
    expect(estimateUnifiedUsageCosts([item], prices).total.requests).toBe(2);
    item.metrics[item.metrics.length - 1].value = 3;
    expect(estimateUnifiedUsageCosts([item], prices).total.requests).toBeNull();
  });

  it("does not combine alternative source, scope, provenance or granularity families", () => {
    const first = bucket();
    const alternatives = [
      first,
      bucket({ source: "local" }),
      bucket({ scope: "other-scope" }),
      bucket({ provenance: "official" }),
      bucket({ granularity: "lifetime", day: null }),
    ];
    const pending = estimateUnifiedUsageCosts(alternatives, prices);
    expect(pending.families).toHaveLength(5);
    expect(pending.total).toMatchObject({
      usd: null,
      measuredTokens: null,
      partial: true,
      reasons: ["select_family"],
    });
    const selected = estimateUnifiedUsageCosts(alternatives, prices, {
      familyKey: usageCostFamilyKey(first),
      usdToCny: 6,
    });
    expect(selected.buckets).toHaveLength(1);
    expect(selected.total.usd).toBeCloseTo(0.00329);
    expect(
      estimateUnifiedUsageCosts(alternatives, prices, { familyKey: "missing" })
        .total.reasons,
    ).toEqual(["unknown_family"]);
  });

  it("never projects lifetime amounts into daily totals", () => {
    const result = estimateUnifiedUsageCosts(
      [bucket({ granularity: "lifetime", day: null })],
      prices,
    );
    expect(result.total.usd).toBeCloseTo(0.00329);
    expect(result.byDay).toEqual({});
  });

  it("excludes ambiguous daily totals and intersecting wildcard dimensions", () => {
    for (const rows of [
      [bucket({ platform: null, feature: null }), bucket()],
      [bucket({ platform: null }), bucket()],
      [bucket({ feature: null }), bucket()],
      [
        bucket({ platform: null, feature: "chat" }),
        bucket({ platform: "web", feature: null }),
      ],
    ]) {
      const total = estimateUnifiedUsageCosts(rows, prices).total;
      expect(total).toMatchObject({
        usd: null,
        measuredTokens: null,
        partial: true,
        unpricedBuckets: 2,
      });
      expect(total.reasons).toContain("overlapping_dimensions");
    }
  });

  it("retains a known partial model subtotal without double-counting model-less summaries", () => {
    const summary = bucket({
      model: null,
      platform: null,
      feature: null,
      metrics: [metric("tokens", 1200)],
    });
    const result = estimateUnifiedUsageCosts([summary, bucket()], prices, {
      usdToCny: 7,
    });
    expect(result.total).toMatchObject({
      partial: true,
      measuredTokens: 1200,
      measuredTokensPartial: true,
      pricedBuckets: 1,
      unpricedBuckets: 1,
    });
    expect(result.total.usd).toBeCloseTo(0.00329);
    expect(result.total.reasons).toContain("overlapping_dimensions");
    expect(result.byModel["model-a"]).toMatchObject({
      partial: true,
      measuredTokens: 1200,
    });
    expect(result.byModel[""].usd).toBeNull();
    expect(result.byModel[""].measuredTokens).toBeNull();
    const ambiguous = estimateUnifiedUsageCosts(
      [summary, bucket(), bucket({ platform: null })],
      prices,
    );
    expect(ambiguous.total.usd).toBeNull();
    expect(ambiguous.total.measuredTokens).toBeNull();
  });

  it("allows disjoint daily partitions and canonical event groups with missing labels", () => {
    const partitioned = estimateUnifiedUsageCosts(
      [bucket(), bucket({ platform: "web" })],
      prices,
    ).total;
    expect(partitioned.usd).toBeCloseTo(0.00658);
    expect(partitioned.partial).toBe(false);
    const disjointWildcards = estimateUnifiedUsageCosts(
      [
        bucket({ platform: null, feature: "chat" }),
        bucket({ platform: "web", feature: "agent" }),
      ],
      prices,
    ).total;
    expect(disjointWildcards.usd).toBeCloseTo(0.00658);
    expect(disjointWildcards.partial).toBe(false);
    const events = estimateUnifiedUsageCosts(
      [
        bucket({ granularity: "event", platform: null, feature: null }),
        bucket({ granularity: "event" }),
      ],
      prices,
    ).total;
    expect(events.usd).toBeCloseTo(0.00658);
  });

  it("does not double-count duplicate buckets even for events", () => {
    const total = estimateUnifiedUsageCosts(
      [bucket({ granularity: "event" }), bucket({ granularity: "event" })],
      prices,
    ).total;
    expect(total.usd).toBeNull();
    expect(total.reasons).toEqual(["duplicate_bucket"]);
  });

  it("keeps missing summaries null and rejects an unsafe aggregate token sum", () => {
    expect(estimateUnifiedUsageCosts([], prices).total).toMatchObject({
      usd: null,
      measuredTokens: null,
      requests: null,
    });
    const huge = bucket({
      metrics: [metric("tokens", Number.MAX_SAFE_INTEGER)],
    });
    const total = estimateUnifiedUsageCosts(
      [huge, { ...huge, accountId: "account-b" }],
      prices,
    ).total;
    expect(total.measuredTokens).toBeNull();
    expect(total.measuredTokensPartial).toBe(true);
    expect(total.reasons).toContain("count_overflow");
  });
});
