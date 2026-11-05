import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { Copy, FolderOpen, Loader2, PackageCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Switch } from "@/components/ui/switch";
import { copyText } from "@/lib/clipboard";
import { CUSTOM_UPDATE_POLICY } from "@/lib/customUpdatePolicy";
import {
  unifiedUpdateApi,
  UNIFIED_UPDATE_CHANGED,
  type UnifiedUpdateStatus,
} from "@/lib/api/unifiedUpdate";

const STATUS_KEY = ["unified-update-status"] as const;

export function UnifiedUpdatePanel({
  availableVersion,
}: {
  availableVersion: string | null;
}) {
  const { t } = useTranslation();
  const tx = (key: string, defaultValue: string) =>
    t(`customUpdates.${key}`, { defaultValue });
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const statusQuery = useQuery({
    queryKey: STATUS_KEY,
    queryFn: unifiedUpdateApi.status,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      query.state.data?.phase === "preparing" ? 2000 : false,
  });
  const status = statusQuery.data;
  const preparing = status?.phase === "preparing";
  const error =
    actionError ??
    (statusQuery.error ? String(statusQuery.error) : null) ??
    status?.error;
  useEffect(() => {
    const changed = () =>
      void client.invalidateQueries({ queryKey: STATUS_KEY });
    window.addEventListener(UNIFIED_UPDATE_CHANGED, changed);
    return () => window.removeEventListener(UNIFIED_UPDATE_CHANGED, changed);
  }, [client]);
  const keepStatus = (next: UnifiedUpdateStatus) => {
    if (next.edition !== CUSTOM_UPDATE_POLICY.edition)
      throw new Error("Unexpected update edition");
    client.setQueryData(STATUS_KEY, next);
    return next;
  };
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current || preparing) return;
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (cause) {
      setActionError(String(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const chooseSource = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: tx("chooseSource", "Choose the custom CC Switch source checkout"),
    });
    if (typeof selected !== "string") return null;
    return keepStatus(
      await unifiedUpdateApi.configure(selected, status?.autoPrepare ?? false),
    );
  };
  const prepare = () =>
    run(async () => {
      if (!availableVersion) return;
      const configured = status?.sourceDir ? status : await chooseSource();
      if (configured?.sourceDir)
        keepStatus(await unifiedUpdateApi.prepare(availableVersion));
    });
  const phases: Record<UnifiedUpdateStatus["phase"], string> = {
    not_configured: tx(
      "notConfigured",
      "Choose a source checkout to enable compatible updates",
    ),
    idle: tx("idle", "Ready to prepare a compatible update"),
    preparing: tx(
      "preparing",
      "Merging upstream changes and validating a separate candidate…",
    ),
    ready: tx(
      "ready",
      "Compatible candidate built; installation has not changed",
    ),
    conflict: tx("conflict", "Merge conflicts require review"),
    migration_review: tx(
      "migrationReview",
      "Database changes require compatibility review",
    ),
    error: tx("failed", "Compatible update preparation failed"),
  };
  return (
    <section
      aria-label={tx("title", "Custom update compatibility")}
      className="space-y-4 px-5 py-4"
    >
      <div className="space-y-1">
        <h3 className="text-body font-semibold text-fg-1">
          {tx("edition", "Unified Usage custom edition")}
        </h3>
        <p className="text-caption text-fg-2">
          {tx("upstreamBase", "Upstream base")}:{" "}
          {status?.upstreamVersion ?? "—"}
        </p>
        <p className="text-caption text-fg-2">
          {tx(
            "policy",
            "Upstream releases contain new CC Switch features, but do not contain this custom analytics feature. Stock updates cannot replace this edition.",
          )}
        </p>
      </div>
      {statusQuery.isLoading ? (
        <p className="text-caption text-fg-2">
          {tx("loading", "Reading custom update status…")}
        </p>
      ) : (
        status && (
          <p
            role="status"
            className="flex items-center gap-2 text-body text-fg-1"
          >
            {preparing && <Loader2 className="h-4 w-4 animate-spin" />}
            {phases[status.phase]}
            {status.targetVersion ? ` · ${status.targetVersion}` : ""}
          </p>
        )
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="neutral"
          size="compact"
          disabled={busy || preparing}
          onClick={() =>
            void run(async () => {
              await chooseSource();
            })
          }
        >
          <FolderOpen className="h-3.5 w-3.5" />
          {tx("sourceFolder", "Choose source folder")}
        </Button>
        <Button
          variant="neutral"
          size="compact"
          disabled={busy || preparing || !availableVersion}
          onClick={() => void prepare()}
        >
          <PackageCheck className="h-3.5 w-3.5" />
          {tx("prepare", "Prepare compatible custom update")}
        </Button>
      </div>
      {status?.sourceDir && (
        <p className="break-all text-caption text-fg-3">
          {tx("source", "Source checkout")}: {status.sourceDir}
        </p>
      )}
      <label className="flex items-start gap-3 text-caption text-fg-2">
        <Switch
          className="mt-0.5"
          aria-label={tx(
            "automatic",
            "Prepare detected upstream updates automatically",
          )}
          checked={status?.autoPrepare ?? false}
          disabled={busy || preparing || !status?.sourceDir}
          onCheckedChange={(enabled) =>
            void run(async () => {
              keepStatus(
                await unifiedUpdateApi.configure(
                  status?.sourceDir ?? null,
                  enabled,
                ),
              );
            })
          }
        />
        <span>
          {tx("automatic", "Prepare detected upstream updates automatically")}
          <span className="mt-1 block text-fg-3">
            {tx(
              "automaticScope",
              "Runs the local merge, test, and build workflow once per detected version. It preserves this installed application, accounts, and data; it does not install or launch the candidate.",
            )}
          </span>
        </span>
      </label>
      {(status?.phase === "conflict" ||
        status?.phase === "migration_review") && (
        <Notice
          tone="warning"
          title={tx(
            "reviewRequired",
            "Review is required before this candidate can be used",
          )}
        >
          {tx(
            "reviewDescription",
            "Keep using the installed custom build. Inspect the candidate's merge or database compatibility report, resolve it in the source checkout, and prepare a new candidate.",
          )}
        </Notice>
      )}
      {status?.candidateDir && (
        <div className="space-y-2 rounded-control bg-subtle p-3 text-caption text-fg-2">
          <p>{tx("candidate", "Candidate and validation reports")}</p>
          <code className="block break-all">{status.candidateDir}</code>
          <Button
            variant="quiet"
            size="compact"
            onClick={() =>
              void copyText(status.candidateDir!).catch((cause) =>
                setActionError(String(cause)),
              )
            }
          >
            <Copy className="h-3.5 w-3.5" />
            {tx("copyPath", "Copy candidate path")}
          </Button>
          {status.phase === "ready" && (
            <p>
              {tx(
                "manualInstall",
                "Review the build and reports before replacing the app manually. This local workflow has no hosted signed update channel and never performs an unattended replacement.",
              )}
            </p>
          )}
        </div>
      )}
      {error && (
        <Notice
          tone="warning"
          title={tx("error", "Custom update could not be completed")}
        >
          {error}
        </Notice>
      )}
    </section>
  );
}
