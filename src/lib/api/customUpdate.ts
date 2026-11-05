import { invoke } from "@tauri-apps/api/core";
import { CUSTOM_UPDATE_POLICY } from "@/lib/customUpdatePolicy";

export interface CustomReleaseStatus {
  configured: boolean;
  edition: typeof CUSTOM_UPDATE_POLICY.edition;
  repository: string | null;
  channel: "stable";
  currentVersion: string;
  reason: string | null;
}

export interface CustomRelease {
  version: string;
  notes: string | null;
  pubDate: string | null;
}

export interface CustomReleaseCheck {
  configured: boolean;
  available: boolean;
  currentVersion: string;
  release: CustomRelease | null;
  reason: string | null;
}

export const CUSTOM_RELEASE_STATUS_KEY = [
  "hosted-custom-update-status",
] as const;
export const CUSTOM_RELEASE_CHECK_KEY = ["hosted-custom-update-check"] as const;
export const CUSTOM_RELEASE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Repository and verification key are pinned in the compiled application. */
export const customUpdateApi = {
  status: () => invoke<CustomReleaseStatus>("custom_update_status"),
  check: () => invoke<CustomReleaseCheck>("custom_update_check"),
  install: (version: string) =>
    invoke<boolean>("custom_update_install", { version }),
};
