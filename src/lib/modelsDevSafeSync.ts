import type { ModelsDevResponse } from "./modelsDev";
import {
  isCanonicalPricingEntry,
  resolveModelsDevSelection,
  type ModelsDevEntry,
} from "./modelsDevPricing";
import type { ModelPricing, ModelsDevSyncConfig } from "@/types/usage";

/** Keep old configured models current too, beyond the six newest common ones. */
export function selectPricingSyncEntries(
  entries: ModelsDevEntry[],
  config: ModelsDevSyncConfig,
  existing: ModelPricing[],
): ModelsDevEntry[] {
  const configured = new Set(
    existing.map((price) => price.modelId.toLowerCase()),
  );
  const excluded = new Set(config.excludedCommonModelKeys);
  const selected = new Set(
    resolveModelsDevSelection(entries, config).map((entry) => entry.key),
  );
  if (config.includeCommonModels) {
    for (const entry of entries) {
      if (
        isCanonicalPricingEntry(entry) &&
        configured.has(entry.normalizedId) &&
        !excluded.has(entry.key)
      )
        selected.add(entry.key);
    }
  }
  const explicit = new Set(config.selectedModelKeys);
  return entries
    .filter((entry) => selected.has(entry.key))
    .sort(
      (left, right) =>
        Number(explicit.has(right.key)) - Number(explicit.has(left.key)),
    );
}

function rate(value: unknown): string | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value >= 1e12
  )
    return null;
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  const [mantissa, rawExponent] = text.toLowerCase().split("e");
  const digits = mantissa.replace(".", "");
  const position = mantissa.split(".")[0].length + Number(rawExponent);
  const expanded =
    position <= 0
      ? `0.${"0".repeat(-position)}${digits}`
      : position >= digits.length
        ? `${digits}${"0".repeat(position - digits.length)}`
        : `${digits.slice(0, position)}.${digits.slice(position)}`;
  // Native decimal storage supports 28 fractional places. Tiny prices must
  // remain unknown instead of rounding to a zero/free price.
  return (expanded.split(".")[1]?.length ?? 0) <= 28 ? expanded : null;
}

function configuredRate(value: string | undefined): string | null {
  if (value === undefined || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 1e12) return null;
  if (parsed === 0 && /[1-9]/.test(value)) return null;
  return value;
}

/** Missing catalog fields preserve known configuration; they never become 0. */
export function safePricingSyncBatch(
  entries: ModelsDevEntry[],
  data: ModelsDevResponse,
  existing: ModelPricing[],
): ModelPricing[] {
  const previous = new Map(
    existing.map((price) => [price.modelId.toLowerCase(), price]),
  );
  const result = new Map<string, ModelPricing>();
  for (const entry of entries) {
    if (result.has(entry.normalizedId)) continue;
    const cost = data[entry.providerId]?.models?.[entry.modelId]?.cost;
    if (!cost || typeof cost !== "object" || Array.isArray(cost)) continue;
    if (
      !entry.normalizedId ||
      entry.normalizedId.length > 256 ||
      /\s|[\u0000-\u001f]/.test(entry.normalizedId)
    )
      continue;
    if (
      typeof entry.modelName !== "string" ||
      !entry.modelName.trim() ||
      entry.modelName.length > 256 ||
      /[\u0000-\u001f]/.test(entry.modelName)
    )
      continue;
    const old = previous.get(entry.normalizedId);
    const resolve = (key: keyof typeof cost, fallback: string | undefined) =>
      cost[key] === undefined || cost[key] === null
        ? configuredRate(fallback)
        : rate(cost[key]);
    const input = resolve("input", old?.inputCostPerMillion);
    const output = resolve("output", old?.outputCostPerMillion);
    const cacheRead = resolve("cache_read", old?.cacheReadCostPerMillion);
    const cacheWrite = resolve("cache_write", old?.cacheCreationCostPerMillion);
    if ([input, output, cacheRead, cacheWrite].some((price) => price === null))
      continue;
    result.set(entry.normalizedId, {
      modelId: entry.normalizedId,
      displayName: entry.modelName,
      inputCostPerMillion: input!,
      outputCostPerMillion: output!,
      cacheReadCostPerMillion: cacheRead!,
      cacheCreationCostPerMillion: cacheWrite!,
    });
  }
  return [...result.values()];
}
