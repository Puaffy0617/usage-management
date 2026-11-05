import type { PropsWithChildren } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getModelPricing: vi.fn(),
  fetchExchangeRates: vi.fn(),
}));
const tauri = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/lib/api/usage", () => ({ usageApi: api }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: tauri }));

import {
  UNIFIED_FX_REFRESH_MS,
  unifiedUsagePricingKeys,
  useUnifiedUsagePricing,
} from "@/hooks/useUnifiedUsagePricing";
import { usageKeys } from "@/lib/query/usage";

const catalog = [
  {
    modelId: "manual-model",
    displayName: "Manual model",
    inputCostPerMillion: "8",
    outputCostPerMillion: "12",
    cacheReadCostPerMillion: "1",
    cacheCreationCostPerMillion: "9",
  },
];
const fetched = () => ({
  rates: { CNY: 7.123 },
  source: "open.er-api.com",
  fetchedAt: Date.now(),
});
const clients: QueryClient[] = [];

function setup(
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  clients.push(client);
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe("useUnifiedUsagePricing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauri.mockReturnValue(true);
    api.getModelPricing.mockResolvedValue(catalog);
    api.fetchExchangeRates.mockImplementation(async () => fetched());
  });
  afterEach(() => {
    cleanup();
    clients.splice(0).forEach((client) => client.clear());
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it("loads the existing model catalog and attributed CNY rate without modifying pricing", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useUnifiedUsagePricing(), { wrapper });
    expect(result.current.fx.status).toBe("loading");
    expect(result.current.usdToCny).toBeNull();
    await waitFor(() => expect(result.current.fx.status).toBe("ready"));
    expect(result.current.pricing).toEqual(catalog);
    expect(result.current.usdToCny).toBe(7.123);
    expect(result.current.fx).toMatchObject({
      source: "open.er-api.com",
      providerName: "ExchangeRate-API",
      providerUrl: "https://www.exchangerate-api.com/",
    });
    expect(result.current.fx.updatedAt).toBeGreaterThan(0);
    expect(api.getModelPricing).toHaveBeenCalledOnce();
    expect(api.fetchExchangeRates).toHaveBeenCalledOnce();
  });

  it("has no static FX fallback when the network fails", async () => {
    api.fetchExchangeRates.mockRejectedValue(new Error("offline"));
    const { wrapper } = setup();
    const { result } = renderHook(() => useUnifiedUsagePricing(), { wrapper });
    await waitFor(() => expect(result.current.fx.status).toBe("unavailable"));
    expect(result.current.usdToCny).toBeNull();
    expect(result.current.fx.source).toBeNull();
    expect(result.current.pricing).toEqual(catalog);
    expect(api.fetchExchangeRates).toHaveBeenCalledOnce();
  });

  it.each([
    { rates: { EUR: 1 }, source: "open.er-api.com", fetchedAt: Date.now() },
    { rates: { CNY: 0 }, source: "open.er-api.com", fetchedAt: Date.now() },
    {
      rates: { CNY: Infinity },
      source: "open.er-api.com",
      fetchedAt: Date.now(),
    },
    { rates: { CNY: 7 }, source: "", fetchedAt: Date.now() },
    { rates: { CNY: 7 }, source: "open.er-api.com", fetchedAt: NaN },
  ])("keeps malformed or missing CNY quotes unavailable", async (quote) => {
    api.fetchExchangeRates.mockResolvedValue(quote);
    const { wrapper } = setup();
    const { result } = renderHook(() => useUnifiedUsagePricing(), { wrapper });
    await waitFor(() => expect(result.current.fx.status).toBe("unavailable"));
    expect(result.current.usdToCny).toBeNull();
  });

  it("reuses a fresh daily cache and the shared manually overridden pricing key", async () => {
    const { client, wrapper } = setup();
    client.setQueryData(usageKeys.pricing(), catalog);
    client.setQueryData(unifiedUsagePricingKeys.exchangeRates, fetched());
    const first = renderHook(() => useUnifiedUsagePricing(), { wrapper });
    expect(first.result.current.usdToCny).toBe(7.123);
    first.unmount();
    const second = renderHook(() => useUnifiedUsagePricing(), { wrapper });
    expect(second.result.current.pricing).toEqual(catalog);
    expect(second.result.current.fx.status).toBe("ready");
    expect(api.getModelPricing).not.toHaveBeenCalled();
    expect(api.fetchExchangeRates).not.toHaveBeenCalled();
    await act(async () => {
      await client.invalidateQueries({ queryKey: usageKeys.pricing() });
    });
    await waitFor(() => expect(api.getModelPricing).toHaveBeenCalledOnce());
    expect(api.fetchExchangeRates).not.toHaveBeenCalled();
  });

  it("refreshes stale FX automatically, preserving source and fetched time after failure", async () => {
    const quote = {
      ...fetched(),
      fetchedAt: Date.now() - UNIFIED_FX_REFRESH_MS - 1000,
      source: "floatrates.com",
    };
    const { client, wrapper } = setup();
    client.setQueryData(unifiedUsagePricingKeys.exchangeRates, quote, {
      updatedAt: quote.fetchedAt,
    });
    api.fetchExchangeRates.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useUnifiedUsagePricing(), { wrapper });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(api.fetchExchangeRates).toHaveBeenCalledOnce();
    expect(result.current.usdToCny).toBe(7.123);
    expect(result.current.fx).toMatchObject({
      status: "stale",
      updatedAt: quote.fetchedAt,
      source: "floatrates.com",
      providerName: "FloatRates",
      providerUrl: "https://www.floatrates.com/",
    });
  });

  it("automatically refreshes once a day while visible and pauses background polling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-05T00:00:00Z"));
    focusManager.setFocused(true);
    const { wrapper } = setup();
    const { result } = renderHook(() => useUnifiedUsagePricing(), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.fx.status).toBe("ready");
    expect(api.fetchExchangeRates).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNIFIED_FX_REFRESH_MS - 2);
    });
    expect(api.fetchExchangeRates).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(api.fetchExchangeRates).toHaveBeenCalledTimes(2);
    focusManager.setFocused(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNIFIED_FX_REFRESH_MS);
    });
    expect(api.fetchExchangeRates).toHaveBeenCalledTimes(2);
  });

  it("manual refresh updates both inputs and does not replace good FX with a malformed quote", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useUnifiedUsagePricing(), { wrapper });
    await waitFor(() => expect(result.current.fx.status).toBe("ready"));
    const oldTimestamp = result.current.fx.updatedAt;
    api.fetchExchangeRates.mockResolvedValue({
      rates: {},
      fetchedAt: Date.now(),
      source: "open.er-api.com",
    });
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.fx.status).toBe("stale"));
    expect(result.current.usdToCny).toBe(7.123);
    expect(result.current.fx.updatedAt).toBe(oldTimestamp);
    expect(api.getModelPricing).toHaveBeenCalledTimes(2);
    expect(api.fetchExchangeRates).toHaveBeenCalledTimes(2);
  });

  it("skips native calls in browser previews and while disabled", async () => {
    tauri.mockReturnValue(false);
    const { wrapper } = setup();
    const { result, rerender } = renderHook(
      ({ enabled }) => useUnifiedUsagePricing(enabled),
      {
        wrapper,
        initialProps: { enabled: true },
      },
    );
    expect(result.current.fx.status).toBe("unavailable");
    expect(result.current.isLoading).toBe(false);
    tauri.mockReturnValue(true);
    rerender({ enabled: false });
    await act(async () => {
      await result.current.refresh();
    });
    expect(api.fetchExchangeRates).not.toHaveBeenCalled();
    expect(api.getModelPricing).not.toHaveBeenCalled();
  });
});
