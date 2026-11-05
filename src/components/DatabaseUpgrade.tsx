import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { exit } from "@tauri-apps/plugin-process";
import { AlertTriangle, ExternalLink, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CUSTOM_UPDATE_POLICY } from "@/lib/customUpdatePolicy";

interface DatabaseUpgradeProps {
  payload: {
    path?: string;
    error?: string;
    kind?: string;
    db_version?: number;
    supported_version?: number;
  };
}

/** A newer schema requires a reviewed custom build, never a stock installer. */
export function DatabaseUpgrade({ payload }: DatabaseUpgradeProps) {
  const { t } = useTranslation();
  return (
    <div
      data-update-edition={CUSTOM_UPDATE_POLICY.edition}
      className="flex min-h-screen items-center justify-center bg-surface p-6 text-fg-1"
    >
      <div className="w-full max-w-lg space-y-5 rounded-panel border border-border bg-surface p-7">
        <div className="flex items-start gap-4">
          <AlertTriangle className="h-6 w-6 shrink-0 text-warning-text" />
          <div className="space-y-2">
            <h1 className="text-title">
              {t("customUpdates.databaseTitle", {
                defaultValue: "A compatible custom build is required",
              })}
            </h1>
            <p className="text-body text-fg-2">
              {t("customUpdates.databaseDescription", {
                defaultValue:
                  "This database was created by a newer application. Keep a backup and use a custom build that supports this schema and retains Unified Usage Analytics. Stock upstream releases cannot safely replace this edition.",
              })}
            </p>
          </div>
        </div>
        <div className="space-y-1 rounded-control bg-subtle p-3 text-caption text-fg-2">
          {payload.db_version !== undefined && (
            <p>
              {t("customUpdates.databaseVersion", {
                defaultValue: "Database schema",
              })}
              : {payload.db_version} ·{" "}
              {t("customUpdates.supportedSchema", {
                defaultValue: "Supported schema",
              })}
              : {payload.supported_version ?? "—"}
            </p>
          )}
          {payload.path && <p className="break-all">{payload.path}</p>}
          {payload.error && <p className="break-words">{payload.error}</p>}
        </div>
        <p className="text-body text-fg-2">
          {t("customUpdates.databaseRecovery", {
            defaultValue:
              "Prepare and review a compatible candidate from the custom source checkout, or restore a backup made by this version. No update check or connection failure will enable a stock installation.",
          })}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="neutral"
            onClick={() =>
              void invoke("open_external", {
                url: "https://github.com/farion1231/cc-switch/releases",
              })
            }
          >
            <ExternalLink className="h-4 w-4" />
            {t("customUpdates.upstreamNotes", {
              defaultValue: "View upstream release notes",
            })}
          </Button>
          <Button
            variant="neutral"
            onClick={() => void invoke("open_app_config_folder")}
          >
            <FolderOpen className="h-4 w-4" />
            {t("dbUpgrade.openConfigDir", {
              defaultValue: "Open configuration folder",
            })}
          </Button>
          <Button variant="quiet" onClick={() => void exit(0)}>
            {t("dbUpgrade.quit", { defaultValue: "Quit" })}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default DatabaseUpgrade;
