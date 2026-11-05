import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Download, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import {
  customUpdateApi,
  CUSTOM_RELEASE_STATUS_KEY,
  CUSTOM_RELEASE_CHECK_KEY,
  type CustomReleaseCheck,
} from "@/lib/api/customUpdate";
import { CUSTOM_UPDATE_POLICY } from "@/lib/customUpdatePolicy";

export function HostedCustomUpdatePanel() {
  const { t } = useTranslation();
  const tx = (key: string, defaultValue: string) =>
    t(`hostedCustomUpdates.${key}`, { defaultValue });
  const client = useQueryClient();
  const statusQuery = useQuery({
    queryKey: CUSTOM_RELEASE_STATUS_KEY,
    queryFn: customUpdateApi.status,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const status = statusQuery.data;
  const configured =
    status?.configured === true &&
    status.edition === CUSTOM_UPDATE_POLICY.edition;
  const checkQuery = useQuery<CustomReleaseCheck | null>({
    queryKey: CUSTOM_RELEASE_CHECK_KEY,
    queryFn: customUpdateApi.check,
    enabled: false,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const checked = checkQuery.data ?? null;
  const setChecked = (value: CustomReleaseCheck | null) =>
    client.setQueryData(CUSTOM_RELEASE_CHECK_KEY, value);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const busyRef = useRef(false);
  const release =
    configured && checked?.configured && checked.available
      ? checked.release
      : null;
  const check = async () => {
    if (!configured || busyRef.current) return;
    busyRef.current = true;
    setChecking(true);
    setError(null);
    setMessage(null);
    setChecked(null);
    try {
      const result = await client.fetchQuery({
        queryKey: CUSTOM_RELEASE_CHECK_KEY,
        queryFn: customUpdateApi.check,
        staleTime: 0,
        retry: false,
      });
      setChecked(result);
      if (!result.configured)
        setMessage(
          result.reason ??
            tx(
              "notConfigured",
              "No signed custom release channel is configured in this build.",
            ),
        );
      else if (!result.available)
        setMessage(
          tx(
            "upToDate",
            "No newer custom release is available from the pinned channel.",
          ),
        );
    } catch (cause) {
      setError(String(cause));
    } finally {
      busyRef.current = false;
      setChecking(false);
    }
  };
  const install = async () => {
    if (!release || !configured || busyRef.current) return;
    busyRef.current = true;
    setInstalling(true);
    setError(null);
    setMessage(null);
    try {
      const installed = await customUpdateApi.install(release.version);
      if (!installed) {
        setChecked(null);
        setMessage(
          tx(
            "noLongerAvailable",
            "No newer custom release remains available. Check the pinned channel again.",
          ),
        );
        busyRef.current = false;
        setInstalling(false);
      }
      // A successful install restarts through the native cleanup path.
    } catch (cause) {
      setChecked(null);
      setError(String(cause));
      busyRef.current = false;
      setInstalling(false);
    }
  };
  return (
    <section
      aria-label={tx("title", "Signed custom releases")}
      className="space-y-3 px-5 py-4"
    >
      <h3 className="flex items-center gap-2 text-body font-semibold text-fg-1">
        <ShieldCheck className="h-4 w-4" />
        {tx("title", "Signed custom releases")}
      </h3>
      <p className="text-caption text-fg-2">
        {tx(
          "description",
          "This separate channel can install Unified Usage custom builds from the repository and verification key pinned in this application. Upstream stock updates stay blocked.",
        )}
      </p>
      <div className="space-y-1 text-caption text-fg-2">
        <p>
          {tx("currentVersion", "Installed custom version")}:{" "}
          {status?.currentVersion ?? "—"}
        </p>
        <p>
          {tx("repository", "Pinned repository")}:{" "}
          {status?.repository ?? tx("none", "Not configured")}
        </p>
        {status && (
          <p>
            {tx("channel", "Channel")}: {status.channel}
          </p>
        )}
      </div>
      {!statusQuery.isLoading && !configured && (
        <Notice
          title={tx(
            "notConfigured",
            "No signed custom release channel is configured in this build.",
          )}
        >
          {status?.reason ??
            tx(
              "disabledExplanation",
              "A maintainer must publish and pin the signed custom channel in a new build before hosted installation is available. The local compatibility workflow remains separate.",
            )}
        </Notice>
      )}
      <Button
        variant="neutral"
        size="compact"
        disabled={!configured || checking || installing}
        onClick={() => void check()}
      >
        {checking ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
        {tx("check", "Check custom releases")}
      </Button>
      {release && (
        <div className="space-y-2 rounded-control bg-subtle p-3 text-caption text-fg-2">
          <p className="font-medium text-fg-1">
            {tx("available", "Custom release available")}: {release.version}
          </p>
          {release.pubDate && (
            <p>
              {tx("published", "Published")}: {release.pubDate}
            </p>
          )}
          {release.notes && (
            <p className="whitespace-pre-wrap">{release.notes}</p>
          )}
          <p>
            {tx(
              "verification",
              "Installation verifies the pinned signature before replacing the app, then restarts it. This action does not change account sign-ins.",
            )}
          </p>
          <Button
            variant="solid"
            size="compact"
            disabled={checking || installing}
            onClick={() => void install()}
          >
            <Download className="h-3.5 w-3.5" />
            {tx("install", "Verify, install custom update, and restart")}
          </Button>
        </div>
      )}
      <div role="status" className="text-caption text-fg-2">
        {statusQuery.isLoading && (
          <p>{tx("loading", "Reading pinned channel configuration…")}</p>
        )}
        {installing && (
          <p className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {tx("installing", "Verifying and installing the custom update…")}
          </p>
        )}
        {message && <p>{message}</p>}
      </div>
      {(error || statusQuery.error || checkQuery.error) && (
        <Notice
          tone="warning"
          title={tx("error", "Custom release update could not be completed")}
        >
          {error ?? String(statusQuery.error ?? checkQuery.error)}
          <p className="mt-1">
            {tx(
              "noFallback",
              "No stock updater or alternate channel will be used. Check the pinned custom channel again before retrying installation.",
            )}
          </p>
        </Notice>
      )}
    </section>
  );
}
