import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getModelsDevSyncConfig,
  getModelPricing,
  updateModelPricingBatch,
  recordModelsDevSyncResult,
} = vi.hoisted(() => ({
  getModelsDevSyncConfig: vi.fn(),
  getModelPricing: vi.fn(),
  updateModelPricingBatch: vi.fn(),
  recordModelsDevSyncResult: vi.fn(),
}));

vi.mock("@/lib/api/usage", () => ({
  usageApi: {
    getModelsDevSyncConfig,
    getModelPricing,
    updateModelPricingBatch,
    recordModelsDevSyncResult,
  },
}));

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import {
  MODELS_DEV_STARTUP_SYNC_INTERVAL_MS,
  MODELS_DEV_BACKGROUND_CHECK_MS,
  startModelsDevPricingBackground,
  syncModelsDevPricing,
} from "@/lib/modelsDevAutoSync";

const state = {
  configPath: "C:/Users/test/.cc-switch/model-pricing.json",
  config: {
    autoSyncEnabled: true,
    includeCommonModels: true,
    selectedModelKeys: ["relay/custom-model"],
    excludedCommonModelKeys: [],
    lastSyncAt: null,
    lastSyncError: null,
  },
};

describe("syncModelsDevPricing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateModelPricingBatch.mockResolvedValue(2);
    recordModelsDevSyncResult.mockResolvedValue(undefined);
    getModelPricing.mockResolvedValue(
      ["gpt-5", "custom-model"].map((modelId) => ({
        modelId,
        displayName: modelId,
        inputCostPerMillion: "9",
        outputCostPerMillion: "9",
        cacheReadCostPerMillion: "0.1",
        cacheCreationCostPerMillion: "2.5",
      })),
    );
    invokeMock.mockImplementation(async (command: string) => {
      if (command !== "fetch_models_dev") {
        throw new Error(`Unexpected command: ${command}`);
      }
      return JSON.stringify({
        openai: {
          models: {
            "gpt-5": {
              name: "GPT-5",
              release_date: "2025-08-01",
              cost: { input: 1, output: 2 },
            },
          },
        },
        relay: {
          models: {
            "custom-model": {
              name: "Custom Model",
              release_date: "2025-07-01",
              cost: { input: 0.5, output: 1 },
            },
          },
        },
      });
    });
  });

  it("skips network access when automatic sync is disabled", async () => {
    getModelsDevSyncConfig.mockResolvedValue({
      ...state,
      config: { ...state.config, autoSyncEnabled: false },
    });

    const result = await syncModelsDevPricing();

    expect(result.skipped).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(updateModelPricingBatch).not.toHaveBeenCalled();
  });

  it("skips startup network access when pricing synced within the interval", async () => {
    // Keep a meaningful margin inside the interval. A 1 ms margin races the
    // async mocked config lookup and makes this test depend on machine load.
    const lastSyncAt =
      Date.now() - MODELS_DEV_STARTUP_SYNC_INTERVAL_MS + 60_000;
    getModelsDevSyncConfig.mockResolvedValue({
      ...state,
      config: { ...state.config, lastSyncAt },
    });

    const result = await syncModelsDevPricing();

    expect(result).toEqual({
      skipped: true,
      selected: 0,
      imported: 0,
      changed: 0,
      syncedAt: lastSyncAt,
    });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(updateModelPricingBatch).not.toHaveBeenCalled();
  });

  it("imports common and explicitly selected models in one batch", async () => {
    getModelsDevSyncConfig.mockResolvedValue(state);

    const result = await syncModelsDevPricing();

    expect(updateModelPricingBatch).toHaveBeenCalledTimes(1);
    expect(updateModelPricingBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ modelId: "gpt-5", inputCostPerMillion: "1" }),
        expect.objectContaining({
          modelId: "custom-model",
          inputCostPerMillion: "0.5",
        }),
      ]),
    );
    expect(result).toMatchObject({
      skipped: false,
      selected: 2,
      imported: 2,
      changed: 2,
    });
    expect(recordModelsDevSyncResult).toHaveBeenCalledWith(
      expect.any(Number),
      null,
    );
    expect(invokeMock).toHaveBeenCalledWith("fetch_models_dev");
  });

  it("stops a startup sync when automatic sync is disabled during download", async () => {
    getModelsDevSyncConfig.mockResolvedValueOnce(state).mockResolvedValueOnce({
      ...state,
      config: { ...state.config, autoSyncEnabled: false, lastSyncAt: 123 },
    });

    const result = await syncModelsDevPricing();

    expect(result).toEqual({
      skipped: true,
      selected: 0,
      imported: 0,
      changed: 0,
      syncedAt: 123,
    });
    expect(updateModelPricingBatch).not.toHaveBeenCalled();
    expect(recordModelsDevSyncResult).not.toHaveBeenCalled();
  });

  it("uses the latest model selection after the download completes", async () => {
    getModelsDevSyncConfig.mockResolvedValueOnce(state).mockResolvedValueOnce({
      ...state,
      config: {
        ...state.config,
        includeCommonModels: false,
        selectedModelKeys: ["relay/custom-model"],
      },
    });

    await syncModelsDevPricing();

    expect(updateModelPricingBatch).toHaveBeenCalledWith([
      expect.objectContaining({ modelId: "custom-model" }),
    ]);
  });

  it("uses the latest selection for a forced sync even when automatic sync is disabled", async () => {
    getModelsDevSyncConfig.mockResolvedValueOnce({
      ...state,
      config: {
        ...state.config,
        autoSyncEnabled: false,
        includeCommonModels: false,
        selectedModelKeys: ["relay/custom-model"],
        lastSyncAt: Date.now(),
      },
    });

    const result = await syncModelsDevPricing(state, true);

    expect(result.skipped).toBe(false);
    expect(updateModelPricingBatch).toHaveBeenCalledWith([
      expect.objectContaining({ modelId: "custom-model" }),
    ]);
  });

  it("persists the last error without replacing the previous success time", async () => {
    const previous = { ...state, config: { ...state.config, lastSyncAt: 123 } };
    getModelsDevSyncConfig.mockResolvedValue(previous);
    invokeMock.mockRejectedValueOnce(new Error("offline"));

    await expect(syncModelsDevPricing()).rejects.toThrow("offline");
    expect(recordModelsDevSyncResult).toHaveBeenCalledWith(null, "offline");
  });

  it("retains known cache prices when the catalog omits them", async () => {
    getModelsDevSyncConfig.mockResolvedValue(state);
    await syncModelsDevPricing();
    expect(updateModelPricingBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          modelId: "gpt-5",
          inputCostPerMillion: "1",
          cacheReadCostPerMillion: "0.1",
          cacheCreationCostPerMillion: "2.5",
        }),
      ]),
    );
  });

  it("does not add a new model with unknown cache rates as a free cache", async () => {
    getModelsDevSyncConfig.mockResolvedValue(state);
    getModelPricing.mockResolvedValue([]);
    const result = await syncModelsDevPricing();
    expect(result.imported).toBe(0);
    expect(updateModelPricingBatch).not.toHaveBeenCalled();
  });

  it("keeps checking prices in the background without a visible usage page", async () => {
    vi.useFakeTimers();
    const hidden = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    let lastSyncAt: number | null = null;
    getModelsDevSyncConfig.mockImplementation(async () => ({
      ...state,
      config: { ...state.config, lastSyncAt },
    }));
    recordModelsDevSyncResult.mockImplementation(
      async (time: number | null) => {
        if (time !== null) lastSyncAt = time;
      },
    );
    const onResult = vi.fn();
    const onError = vi.fn();
    const stop = startModelsDevPricingBackground(onResult, onError);
    try {
      await vi.advanceTimersByTimeAsync(MODELS_DEV_BACKGROUND_CHECK_MS);
      expect(updateModelPricingBatch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(MODELS_DEV_BACKGROUND_CHECK_MS);
      expect(updateModelPricingBatch).toHaveBeenCalledTimes(1);
      expect(onResult).toHaveBeenCalledTimes(2);
      expect(onError).not.toHaveBeenCalled();
      stop();
      await vi.advanceTimersByTimeAsync(MODELS_DEV_STARTUP_SYNC_INTERVAL_MS);
      expect(updateModelPricingBatch).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      hidden.mockRestore();
      vi.useRealTimers();
    }
  });

  it("coalesces overlapping manual and background requests", async () => {
    getModelsDevSyncConfig.mockResolvedValue(state);
    const first = syncModelsDevPricing();
    const second = syncModelsDevPricing(undefined, true);
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(updateModelPricingBatch).toHaveBeenCalledTimes(1);
  });

  it("refreshes instead of stalling behind a future success timestamp", async () => {
    getModelsDevSyncConfig.mockResolvedValue({
      ...state,
      config: { ...state.config, lastSyncAt: Date.now() + 86_400_000 },
    });
    const result = await syncModelsDevPricing();
    expect(result.skipped).toBe(false);
    expect(updateModelPricingBatch).toHaveBeenCalledTimes(1);
  });
});
