import { usageApi } from "@/lib/api/usage";
import { fetchModelsDev } from "@/lib/modelsDev";
import { flattenModels } from "@/lib/modelsDevPricing";
import {
  safePricingSyncBatch,
  selectPricingSyncEntries,
} from "@/lib/modelsDevSafeSync";
import type { ModelsDevSyncState } from "@/types/usage";

export interface ModelsDevSyncResult {
  skipped: boolean;
  selected: number;
  imported: number;
  changed: number;
  syncedAt: number | null;
}

export const MODELS_DEV_SYNC_CONFIG_QUERY_KEY = [
  "models-dev-sync-config",
] as const;
export const MODELS_DEV_STARTUP_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const MODELS_DEV_BACKGROUND_CHECK_MS = 15 * 60 * 1000;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

async function performPricingSync(
  state?: ModelsDevSyncState,
  force = false,
): Promise<ModelsDevSyncResult> {
  const initialState = state ?? (await usageApi.getModelsDevSyncConfig());
  const recentlySynced =
    initialState.config.lastSyncAt !== null &&
    initialState.config.lastSyncAt <= Date.now() &&
    Date.now() - initialState.config.lastSyncAt <
      MODELS_DEV_STARTUP_SYNC_INTERVAL_MS;
  if (!force && (!initialState.config.autoSyncEnabled || recentlySynced)) {
    return {
      skipped: true,
      selected: 0,
      imported: 0,
      changed: 0,
      syncedAt: initialState.config.lastSyncAt,
    };
  }

  try {
    const data = await fetchModelsDev();
    const latestState = await usageApi.getModelsDevSyncConfig();
    if (!force && !latestState.config.autoSyncEnabled) {
      return {
        skipped: true,
        selected: 0,
        imported: 0,
        changed: 0,
        syncedAt: latestState.config.lastSyncAt,
      };
    }
    const existing = await usageApi.getModelPricing();
    const selectedEntries = selectPricingSyncEntries(
      flattenModels(data),
      latestState.config,
      existing,
    );
    const pricing = safePricingSyncBatch(selectedEntries, data, existing);
    const changed = pricing.length
      ? await usageApi.updateModelPricingBatch(pricing)
      : 0;
    const syncedAt = Date.now();
    await usageApi.recordModelsDevSyncResult(syncedAt, null);
    return {
      skipped: false,
      selected: selectedEntries.length,
      imported: pricing.length,
      changed,
      syncedAt,
    };
  } catch (error) {
    try {
      await usageApi.recordModelsDevSyncResult(null, errorMessage(error));
    } catch (saveError) {
      console.warn(
        "[models.dev] Failed to persist automatic sync error",
        saveError,
      );
    }
    throw error;
  }
}

let pendingSync: Promise<ModelsDevSyncResult> | null = null;

export function syncModelsDevPricing(
  state?: ModelsDevSyncState,
  force = false,
): Promise<ModelsDevSyncResult> {
  if (!pendingSync) {
    pendingSync = performPricingSync(state, force).finally(() => {
      pendingSync = null;
    });
  }
  return pendingSync;
}

let startupSync: Promise<ModelsDevSyncResult> | null = null;

/** Run once per renderer and at most once per interval across WebView rebuilds. */
export function syncModelsDevPricingOnStartup(): Promise<ModelsDevSyncResult> {
  startupSync ??= syncModelsDevPricing();
  return startupSync;
}

/** App-lifetime maintenance; no usage-page, visibility or focus prerequisite. */
export function startModelsDevPricingBackground(
  onResult: (result: ModelsDevSyncResult) => void | Promise<void>,
  onError: (error: unknown) => void,
): () => void {
  const run = () => void syncModelsDevPricing().then(onResult).catch(onError);
  const timer = window.setInterval(run, MODELS_DEV_BACKGROUND_CHECK_MS);
  return () => window.clearInterval(timer);
}
