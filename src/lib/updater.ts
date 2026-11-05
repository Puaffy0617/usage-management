import { getVersion } from "@tauri-apps/api/app";
import { CUSTOM_UPDATE_POLICY } from "./customUpdatePolicy";
import { isUpdateAvailable } from "./version";

export type UpdateChannel = "stable" | "beta";

export interface UpdateInfo {
  distribution: "upstream";
  canInstall: false;
  currentVersion: string;
  availableVersion: string;
  notes?: string;
  pubDate?: string;
}

export interface CheckOptions {
  timeout?: number;
  channel?: UpdateChannel;
}

export async function getCurrentVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "";
  }
}

export async function checkForUpdate(
  opts: CheckOptions = {},
): Promise<
  { status: "up-to-date" } | { status: "available"; info: UpdateInfo }
> {
  // 动态引入，避免在未安装插件时导致打包期问题
  const { check } = await import("@tauri-apps/plugin-updater");

  const currentVersion = await getCurrentVersion();
  const update = await check({ timeout: opts.timeout ?? 30000 } as any);

  // A custom prerelease version sorts below the corresponding stock release.
  // Compare stock metadata with the recorded upstream base instead.
  if (
    !update ||
    !isUpdateAvailable(CUSTOM_UPDATE_POLICY.upstreamVersion, update.version)
  ) {
    return { status: "up-to-date" };
  }

  const info: UpdateInfo = {
    distribution: "upstream",
    canInstall: CUSTOM_UPDATE_POLICY.stockInstallAllowed,
    currentVersion,
    availableVersion: (update as any).version ?? "",
    notes: (update as any).notes,
    pubDate: (update as any).date,
  };

  return { status: "available", info };
}
