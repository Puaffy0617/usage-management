import { invoke } from "@tauri-apps/api/core";
import { CUSTOM_UPDATE_POLICY } from "@/lib/customUpdatePolicy";

export interface UnifiedUpdateStatus {
  edition: typeof CUSTOM_UPDATE_POLICY.edition;
  upstreamVersion: string;
  sourceDir: string | null;
  autoPrepare: boolean;
  phase:
    | "not_configured"
    | "idle"
    | "preparing"
    | "ready"
    | "conflict"
    | "migration_review"
    | "error";
  targetVersion: string | null;
  candidateDir: string | null;
  error: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
}

export const UNIFIED_UPDATE_CHANGED = "cc-switch:unified-update-changed";

export const unifiedUpdateApi = {
  status: () => invoke<UnifiedUpdateStatus>("unified_update_status"),
  configure: (sourceDir: string | null, autoPrepare: boolean) =>
    invoke<UnifiedUpdateStatus>("unified_update_configure", {
      sourceDir,
      autoPrepare,
    }),
  prepare: (targetVersion: string) =>
    invoke<UnifiedUpdateStatus>("unified_update_prepare", { targetVersion }),
  onUpstreamAvailable: (version: string) =>
    invoke<UnifiedUpdateStatus>("unified_update_on_upstream_available", {
      version,
    }),
};
