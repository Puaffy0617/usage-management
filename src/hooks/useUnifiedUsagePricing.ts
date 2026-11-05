import { isTauri } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { resolveRateProvider } from "@/components/usage/format";
import { usageApi } from "@/lib/api/usage";
import { usageKeys } from "@/lib/query/usage";
import type { FetchedExchangeRates } from "@/types";

export const UNIFIED_FX_REFRESH_MS = 24 * 60 * 60 * 1000;
export const unifiedUsagePricingKeys = {
  exchangeRates: ["unified-usage-pricing", "exchange-rates", "USD"] as const,
};

export interface UnifiedUsageFx {
  status: "loading" | "ready" | "stale" | "unavailable";
  source: string | null;
  /** Time fetched by this application, not the provider's quote time. */
  updatedAt: number | null;
  providerName: string | null;
  providerUrl: string | null;
  isFetching: boolean;
}

function validQuote(value: FetchedExchangeRates): boolean {
  return (
    typeof value?.rates?.CNY === "number" &&
    Number.isFinite(value.rates.CNY) &&
    value.rates.CNY > 0 &&
    Number.isFinite(value.fetchedAt) &&
    value.fetchedAt > 0 &&
    value.fetchedAt <= Date.now() + 5 * 60 * 1000 &&
    typeof value.source === "string" &&
    value.source.trim().length > 0
  );
}

/** Account-view CNY conversion; leaves the global manual FX settings intact. */
export function useUnifiedUsagePricing(enabled = true) {
  const active = enabled && isTauri();
  // Reuse the catalog key: manual pricing edits invalidate this query too.
  const pricing = useQuery({
    queryKey: usageKeys.pricing(),
    queryFn: usageApi.getModelPricing,
    enabled: active,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const rates = useQuery({
    queryKey: unifiedUsagePricingKeys.exchangeRates,
    queryFn: async () => {
      const fetched = await usageApi.fetchExchangeRates();
      if (!validQuote(fetched))
        throw new Error("CNY exchange rate unavailable");
      return fetched;
    },
    enabled: active,
    staleTime: UNIFIED_FX_REFRESH_MS,
    gcTime: UNIFIED_FX_REFRESH_MS,
    refetchInterval: UNIFIED_FX_REFRESH_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const quote = rates.data && validQuote(rates.data) ? rates.data : null;
  const knownProvider =
    quote &&
    (quote.source === "open.er-api.com" || quote.source === "floatrates.com")
      ? resolveRateProvider(quote.source)
      : null;
  const fx: UnifiedUsageFx = {
    status: quote
      ? rates.isError || Date.now() - quote.fetchedAt >= UNIFIED_FX_REFRESH_MS
        ? "stale"
        : "ready"
      : active && rates.isPending
        ? "loading"
        : "unavailable",
    source: quote?.source ?? null,
    updatedAt: quote?.fetchedAt ?? null,
    providerName: knownProvider?.name ?? quote?.source ?? null,
    providerUrl: knownProvider?.url ?? null,
    isFetching: rates.isFetching,
  };
  return {
    pricing: pricing.data ?? [],
    usdToCny: quote?.rates.CNY ?? null,
    fx,
    isLoading: active && (pricing.isPending || rates.isPending),
    error: pricing.error ?? rates.error,
    refresh: async (): Promise<void> => {
      if (!active) return;
      await Promise.all([pricing.refetch(), rates.refetch()]);
    },
  };
}
