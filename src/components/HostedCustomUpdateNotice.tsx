import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  customUpdateApi,
  CUSTOM_RELEASE_STATUS_KEY,
  CUSTOM_RELEASE_CHECK_KEY,
  CUSTOM_RELEASE_CHECK_INTERVAL_MS,
} from "@/lib/api/customUpdate";
import { CUSTOM_UPDATE_POLICY } from "@/lib/customUpdatePolicy";
import { toast } from "@/lib/toast";

/** A read-only startup check. Installation remains an explicit About-page action. */
export function HostedCustomUpdateNotice() {
  const { t } = useTranslation();
  const notified = useRef<string | null>(null);
  const status = useQuery({
    queryKey: CUSTOM_RELEASE_STATUS_KEY,
    queryFn: customUpdateApi.status,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const configured =
    status.data?.configured === true &&
    status.data.edition === CUSTOM_UPDATE_POLICY.edition;
  const check = useQuery({
    queryKey: CUSTOM_RELEASE_CHECK_KEY,
    queryFn: customUpdateApi.check,
    enabled: configured,
    staleTime: CUSTOM_RELEASE_CHECK_INTERVAL_MS,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: configured ? CUSTOM_RELEASE_CHECK_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });
  const release =
    check.data?.configured && check.data.available ? check.data.release : null;
  useEffect(() => {
    if (!configured || !release) return;
    const key = `cc-switch:custom-release-notice:${status.data!.currentVersion}:${release.version}`;
    if (notified.current === key) return;
    notified.current = key;
    try {
      if (localStorage.getItem(key) === "1") return;
    } catch {
      /* The in-memory guard remains active. */
    }
    toast.info(
      t("hostedCustomUpdates.notice", {
        version: release.version,
        defaultValue:
          "New custom release {{version}} is available. Open Settings → About to review and install.",
      }),
      { id: key, duration: 8000, closeButton: true },
    );
    try {
      localStorage.setItem(key, "1");
    } catch {
      /* Notification does not depend on writable storage. */
    }
  }, [configured, release, status.data, t]);
  return null;
}
