import { describe, expect, it } from "vitest";
import { flattenModels } from "@/lib/modelsDevPricing";
import {
  safePricingSyncBatch,
  selectPricingSyncEntries,
} from "@/lib/modelsDevSafeSync";
import type { ModelsDevResponse } from "@/lib/modelsDev";
import type { ModelPricing, ModelsDevSyncConfig } from "@/types/usage";

const config: ModelsDevSyncConfig = {
  autoSyncEnabled: true,
  includeCommonModels: true,
  selectedModelKeys: [],
  excludedCommonModelKeys: [],
  lastSyncAt: null,
  lastSyncError: null,
};
const old = (modelId = "gpt-old"): ModelPricing => ({
  modelId,
  displayName: modelId,
  inputCostPerMillion: "1",
  outputCostPerMillion: "2",
  cacheReadCostPerMillion: "0.1",
  cacheCreationCostPerMillion: "2.5",
});
const catalog = (cost: object): ModelsDevResponse =>
  ({
    openai: { models: { "gpt-old": { name: "Old GPT", cost } } },
  }) as ModelsDevResponse;

describe("safe automatic pricing refresh", () => {
  it("refreshes configured canonical models older than the newest six", () => {
    const models: NonNullable<ModelsDevResponse[string]["models"]> = {};
    for (let i = 0; i < 8; i++)
      models[`gpt-${i}`] = {
        name: `GPT ${i}`,
        release_date: `2026-01-0${i + 1}`,
        cost: { input: 1, output: 2 },
      };
    const entries = flattenModels({ openai: { models } });
    const selected = selectPricingSyncEntries(entries, config, [old("gpt-0")]);
    expect(selected.map((entry) => entry.modelId)).toContain("gpt-0");
    expect(selected).toHaveLength(7);
    expect(
      selectPricingSyncEntries(
        entries,
        { ...config, excludedCommonModelKeys: ["openai/gpt-0"] },
        [old("gpt-0")],
      ).map((entry) => entry.modelId),
    ).not.toContain("gpt-0");
  });

  it("preserves known omitted rates and accepts explicitly reported zero", () => {
    const data = catalog({ input: 3, output: 4, cache_read: 0 });
    const result = safePricingSyncBatch(flattenModels(data), data, [old()]);
    expect(result).toEqual([
      expect.objectContaining({
        inputCostPerMillion: "3",
        outputCostPerMillion: "4",
        cacheReadCostPerMillion: "0",
        cacheCreationCostPerMillion: "2.5",
      }),
    ]);
  });

  it("does not invent unknown prices for a newly discovered model", () => {
    const data = catalog({ input: 3, output: 4 });
    expect(safePricingSyncBatch(flattenModels(data), data, [])).toEqual([]);
  });

  it("keeps tiny positive rates positive and rejects unsupported decimal underflow", () => {
    const data = catalog({
      input: 1e-8,
      output: 2,
      cache_read: 0,
      cache_write: 0,
    });
    expect(
      safePricingSyncBatch(flattenModels(data), data, [old()])[0]
        .inputCostPerMillion,
    ).toBe("0.00000001");
    const underflow = catalog({
      input: 1e-29,
      output: 2,
      cache_read: 0,
      cache_write: 0,
    });
    expect(
      safePricingSyncBatch(flattenModels(underflow), underflow, [old()]),
    ).toEqual([]);
  });

  it("rejects negative and nonfinite feed rates instead of replacing prices", () => {
    for (const input of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
      const data = catalog({ input, output: 2, cache_read: 0, cache_write: 0 });
      expect(safePricingSyncBatch(flattenModels(data), data, [old()])).toEqual(
        [],
      );
    }
  });

  it("prioritizes an explicitly selected provider for the same normalized model", () => {
    const data = {
      openai: {
        models: {
          "gpt-old": {
            name: "Canonical",
            cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
          },
        },
      },
      relay: {
        models: {
          "gpt-old": {
            name: "Selected relay",
            cost: { input: 5, output: 6, cache_read: 0, cache_write: 0 },
          },
        },
      },
    };
    const selected = selectPricingSyncEntries(
      flattenModels(data),
      { ...config, selectedModelKeys: ["relay/gpt-old"] },
      [old()],
    );
    expect(safePricingSyncBatch(selected, data, [old()])[0]).toMatchObject({
      inputCostPerMillion: "5",
      displayName: "Selected relay",
    });
  });
});
