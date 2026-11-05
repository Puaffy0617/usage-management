import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  ChartColumn,
  Download,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  Upload,
} from "lucide-react";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { Button } from "@/components/ui/button";
import { Input, fieldClass } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { unifiedUsageApi } from "@/lib/api/unifiedUsage";
import { settingsApi } from "@/lib/api/settings";
import { deliverLoginLink } from "@/lib/authLoginLink";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { PageTabs } from "@/components/ui/page-tabs";
import { Switch } from "@/components/ui/switch";
import { HelpTip } from "@/components/ui/help-tip";
import {
  UnifiedUsageOverview,
  type UnifiedOverviewMetric,
} from "./UnifiedUsageOverview";
import { formatTokensCompact } from "./format";
import { UnifiedThreadUsagePanel } from "./UnifiedThreadUsagePanel";
import { useUnifiedUsagePricing } from "@/hooks/useUnifiedUsagePricing";
import { estimateUnifiedUsageCosts } from "@/lib/unifiedUsageCost";
import { WINDOW_ACTIVITY_EVENT } from "@/lib/windowActivity";
import type {
  AnalyticsAccount,
  AnalyticsImportFormat,
  AnalyticsLogin,
  AnalyticsSyncSettings,
  AnalyticsBackgroundSyncStatus,
  UsageBucket,
} from "@/types/unifiedUsage";
import {
  formatAnalyticsTimestamp,
  formatApiEquivalentCny,
  utcRange,
} from "./unifiedUsageData";

const QUERY_KEY = ["unified-usage"] as const;
const READ_POLL_MS = 30_000;
const COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "#0891b2",
  "#d97706",
  "#e11d48",
  "#16a34a",
];
const PANEL = "rounded-panel border border-border bg-surface p-4";
const SELECT = cn(fieldClass, "h-8 w-auto min-w-[130px]");
const PROVENANCE_RANK = new Map([
  ["official", 0],
  ["local", 1],
  ["estimated", 2],
]);

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Quotas are snapshots of named windows, never token counters or additive totals. */
function Quota({
  account,
  locale,
}: {
  account: AnalyticsAccount;
  locale: string;
}) {
  const { t } = useTranslation();
  const tx = (key: string, defaultValue: string) =>
    t(`unifiedUsage.${key}`, { defaultValue });
  const quota = account.quota;
  const limits = object(quota?.rateLimits) ?? quota;
  const byId = object(quota?.rateLimitsByLimitId);
  const entries =
    byId && Object.keys(byId).length
      ? Object.entries(byId)
      : limits
        ? [["", limits] as const]
        : [];
  const windows = entries.flatMap(([id, value]) => {
    const rate = object(value);
    return ["primary", "secondary"].flatMap((window) => {
      const details = object(rate?.[window]);
      if (!details || typeof details.usedPercent !== "number") return [];
      return [{ id, window, details, used: details.usedPercent }];
    });
  });
  const credits = entries.flatMap(([id, value]) => {
    const rate = object(value);
    const credit = object(rate?.credits);
    if (
      !credit ||
      !["balance", "hasCredits", "unlimited"].some(
        (key) => credit[key] !== null && credit[key] !== undefined,
      )
    )
      return [];
    return [
      {
        id,
        name: typeof rate?.limitName === "string" ? rate.limitName : id,
        credit,
      },
    ];
  });
  const resetCredits = object(quota?.rateLimitResetCredits);
  const availableResets =
    typeof resetCredits?.availableCount === "number"
      ? resetCredits.availableCount
      : null;
  if (!windows.length && !credits.length && availableResets === null)
    return (
      <span className="text-fg-3">
        {tx("quotaUnavailable", "Quota not reported")}
      </span>
    );
  return (
    <div className="space-y-2 text-caption">
      {credits.map(({ id, name, credit }) => (
        <div key={`credits-${id}`} className="space-y-0.5">
          <p className="font-medium">
            {name || tx("planAllowance", "Plan allowance")}
          </p>
          {typeof credit.balance === "string" && (
            <p>
              {tx("creditBalance", "Credit balance")}: {credit.balance}
            </p>
          )}
          {typeof credit.hasCredits === "boolean" && (
            <p>
              {credit.hasCredits
                ? tx("creditsAvailable", "Credits available")
                : tx("noCredits", "No credits available")}
            </p>
          )}
          {typeof credit.unlimited === "boolean" && (
            <p>
              {tx("unlimitedCredits", "Unlimited credits")}:{" "}
              {credit.unlimited ? tx("yes", "Yes") : tx("no", "No")}
            </p>
          )}
        </div>
      ))}
      {availableResets !== null && (
        <p>
          {tx("availableResets", "Available earned resets")}:{" "}
          {availableResets.toLocaleString(locale)}
        </p>
      )}
      {windows.map(({ id, window, details, used }) => (
        <div key={`${id}-${window}`}>
          <div className="flex flex-wrap justify-between gap-2">
            <span>
              {id || tx("planAllowance", "Plan allowance")} ·{" "}
              {typeof details.windowDurationMins === "number"
                ? `${details.windowDurationMins} min`
                : window}
            </span>
            <span>
              {Math.max(0, 100 - used).toLocaleString(locale, {
                maximumFractionDigits: 1,
              })}
              % {tx("remaining", "remaining")}
            </span>
          </div>
          <progress
            className="h-1.5 w-full accent-current"
            aria-label={`${id} ${window}`}
            value={Math.min(100, Math.max(0, used))}
            max={100}
          />
          {typeof details.resetsAt === "number" && (
            <div className="text-fg-3">
              {tx("resets", "Resets")}{" "}
              {formatAnalyticsTimestamp(details.resetsAt * 1000, locale)}
            </div>
          )}
        </div>
      ))}
      {account.quotaUpdatedAt !== null && (
        <p className="text-fg-3">
          {tx("snapshot", "Snapshot")}{" "}
          {formatAnalyticsTimestamp(account.quotaUpdatedAt, locale)}
        </p>
      )}
    </div>
  );
}

function AccountSummary({
  account,
  number,
}: {
  account: AnalyticsAccount;
  number: (value: number) => string;
}) {
  const { t } = useTranslation();
  const tx = (key: string, defaultValue: string) =>
    t(`unifiedUsage.${key}`, { defaultValue });
  const fields = [
    [
      "lifetimeTokens",
      "serviceLifetime",
      "Retained lifetime tokens (separate)",
    ],
    ["peakDailyTokens", "peakDailyTokens", "Peak daily tokens"],
    ["currentStreakDays", "currentStreakDays", "Current streak (days)"],
    ["longestStreakDays", "longestStreakDays", "Longest streak (days)"],
    [
      "longestRunningTurnSec",
      "longestRunningTurnSec",
      "Longest turn (seconds)",
    ],
  ].filter(([key]) => typeof account.summary?.[key] === "number");
  if (!fields.length) return null;
  return (
    <div className="mt-2 max-w-[180px] space-y-1 text-caption text-fg-3">
      <p className="font-medium">
        {tx("summarySnapshot", "Service activity summary (separate snapshot)")}
      </p>
      {fields.map(([key, label, fallback]) => (
        <p key={key}>
          {tx(label, fallback)}: {number(account.summary![key] as number)}
        </p>
      ))}
      <p>
        {tx(
          "retainedSummary",
          "This snapshot may be older than the last sync.",
        )}
      </p>
    </div>
  );
}

export function UnifiedUsageDashboard({
  navigation,
}: {
  navigation?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const tx = (key: string, defaultValue: string) =>
    t(`unifiedUsage.${key}`, { defaultValue });
  const locale = i18n.language || "en";
  const number = (value: number) =>
    Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
      ? value.toLocaleString(locale, { maximumFractionDigits: 2 })
      : tx("numericRange", "Outside supported numeric range");
  const queryClient = useQueryClient();
  const [days, setDays] = useState("all");
  const [accountId, setAccountId] = useState("");
  const [model, setModel] = useState("");
  const [platform, setPlatform] = useState("");
  const [feature, setFeature] = useState("");
  const [chosenFamily, setChosenFamily] = useState("");
  const [overviewMetric, setOverviewMetric] =
    useState<UnifiedOverviewMetric>("tokens");
  const [tab, setTab] = useState<"accounts" | "models" | "details">("accounts");
  const [manageOpen, setManageOpen] = useState(false);
  const threadDetailsRef = useRef<HTMLDivElement>(null);
  const [detailPage, setDetailPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<AnalyticsAccount | "new" | null>(null);
  const [name, setName] = useState("");
  const [interval, setIntervalMinutes] = useState("0");
  const [removing, setRemoving] = useState<AnalyticsAccount | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importAccount, setImportAccount] = useState("");
  const [importFormat, setImportFormat] =
    useState<AnalyticsImportFormat>("chatgpt_export");
  const [login, setLogin] = useState<
    (AnalyticsLogin & { accountId: string }) | null
  >(null);
  const loginRef = useRef<typeof login>(null);

  const syncSettingsQuery = useQuery({
    queryKey: [...QUERY_KEY, "sync-settings"],
    queryFn: () => unifiedUsageApi.getSyncSettings(),
    retry: false,
  });
  const syncStatusQuery = useQuery({
    queryKey: [...QUERY_KEY, "sync-status"],
    queryFn: () => unifiedUsageApi.syncStatus(),
    refetchInterval: READ_POLL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const syncSettings = syncSettingsQuery.data;
  const backgroundSync = syncStatusQuery.data;
  const accountsQuery = useQuery({
    queryKey: [...QUERY_KEY, "accounts"],
    queryFn: unifiedUsageApi.listAccounts,
    refetchInterval: READ_POLL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const accounts = accountsQuery.data ?? [];
  const baseFilter = {
    ...utcRange(days === "all" ? null : Number(days)),
    ...(accountId ? { accountIds: [accountId] } : {}),
  };
  const baseQuery = useQuery({
    queryKey: [...QUERY_KEY, "dashboard", baseFilter],
    queryFn: () => unifiedUsageApi.dashboard(baseFilter),
    refetchInterval: READ_POLL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const hasDimensions = Boolean(model || platform || feature);
  const scopedFilter = {
    ...baseFilter,
    model: model || undefined,
    platform: platform || undefined,
    feature: feature || undefined,
  };
  const scopedQuery = useQuery({
    queryKey: [...QUERY_KEY, "dashboard", scopedFilter],
    queryFn: () => unifiedUsageApi.dashboard(scopedFilter),
    enabled: hasDimensions,
    refetchInterval: READ_POLL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const activeQuery = hasDimensions ? scopedQuery : baseQuery;
  const data = activeQuery.data;
  const selectedAccounts = accounts.filter(
    (account) => !accountId || account.id === accountId,
  );
  const pricing = useUnifiedUsagePricing();
  const fxProviderUrl =
    pricing.fx.providerUrl &&
    [
      "https://www.exchangerate-api.com/",
      "https://www.floatrates.com/",
    ].includes(pricing.fx.providerUrl)
      ? pricing.fx.providerUrl
      : null;
  const allBuckets = data?.usageBuckets ?? [];
  const catalog = useMemo(
    () =>
      estimateUnifiedUsageCosts(
        baseQuery.data?.usageBuckets ?? [],
        pricing.pricing,
        { usdToCny: pricing.usdToCny },
      ),
    [baseQuery.data, pricing.pricing, pricing.usdToCny],
  );
  const families = [...catalog.families].sort(
    (a, b) =>
      (PROVENANCE_RANK.get(a.provenance) ?? 3) -
      (PROVENANCE_RANK.get(b.provenance) ?? 3),
  );
  const familyKey = families.some((family) => family.key === chosenFamily)
    ? chosenFamily
    : families[0]?.key;
  const report = useMemo(
    () =>
      estimateUnifiedUsageCosts(allBuckets, pricing.pricing, {
        familyKey,
        usdToCny: pricing.usdToCny,
      }),
    [data, familyKey, pricing.pricing, pricing.usdToCny],
  );
  const money = (value: number | null) => formatApiEquivalentCny(value, locale);
  const count = (value: number | null) =>
    value === null
      ? "—"
      : Number.isFinite(value) && value <= Number.MAX_SAFE_INTEGER
        ? formatTokensCompact(value, locale)
        : tx("numericRange", "Outside supported numeric range");
  const percent = (value: number | null) =>
    value === null
      ? "—"
      : new Intl.NumberFormat(locale, {
          style: "percent",
          maximumFractionDigits: 1,
        }).format(value);
  const dayValues = Object.fromEntries(
    Object.entries(report.byDay).map(([day, value]) => [
      day,
      {
        cost: value.cny,
        requests: value.requests,
        tokens: value.measuredTokens,
        hitRate: value.cacheHitRate,
      },
    ]),
  );
  useEffect(
    () => setDetailPage(0),
    [days, accountId, model, platform, feature, familyKey],
  );
  const costUnavailableReason = report.total.reasons.includes("missing_model")
    ? tx(
        "costMissingModel",
        "The source has not reported model details for pricing.",
      )
    : report.total.reasons.some((reason) =>
          ["missing_token_breakdown", "ambiguous_input_tokens"].includes(
            reason,
          ),
        )
      ? tx(
          "costMissingBreakdown",
          "Billing-compatible input/output token details have not been reported.",
        )
      : report.total.reasons.includes("missing_price")
        ? tx("costMissingPrice", "The model has no configured API price.")
        : "";
  const originLabel = (origin: string) => {
    if (["official", "officially_reported"].includes(origin))
      return tx("official", "Officially reported");
    if (["local", "locally_measured"].includes(origin))
      return tx("local", "Locally measured");
    if (origin === "estimated") return tx("estimated", "Estimated");
    return origin;
  };
  const familyLabel = (row: {
    source: string;
    scope: string;
    provenance: string;
    granularity: string;
  }) => {
    const source =
      row.source === "codex_app_server"
        ? tx("accountService", "Official account service")
        : row.source === "chatgpt_data_export"
          ? tx("exportSource", "ChatGPT data export")
          : row.source === "imported_usage"
            ? tx("importSource", "Imported records")
            : row.source;
    const coverage =
      row.scope === "codex_account_activity"
        ? tx("serviceCoverage", "Service activity; Chat coverage unconfirmed")
        : row.scope === "chatgpt_export_activity"
          ? tx("exportCoverage", "Exported conversation metadata")
          : row.scope;
    const granularity =
      row.granularity === "day"
        ? tx("familyDay", "Daily")
        : row.granularity === "event"
          ? tx("familyEvent", "Event aggregates")
          : row.granularity === "lifetime"
            ? tx("familyLifetime", "Lifetime")
            : tx("notReported", "Not reported");
    return `${source} · ${originLabel(row.provenance)} · ${coverage} · ${granularity}`;
  };
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(String(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
      await invalidate();
    }
  };
  const sync = async (id?: string) => {
    const result = await unifiedUsageApi.sync(id);
    queryClient.setQueryData([...QUERY_KEY, "accounts"], result.accounts);
    if (result.alreadyRunning)
      queryClient.setQueryData<AnalyticsBackgroundSyncStatus>(
        [...QUERY_KEY, "sync-status"],
        (previous) => (previous ? { ...previous, running: true } : previous),
      );
    if (result.errors.length) setError(result.errors.join("\n"));
  };
  const saveSyncSettings = (settings: AnalyticsSyncSettings) =>
    run(async () => {
      const saved = await unifiedUsageApi.setSyncSettings(settings);
      queryClient.setQueryData([...QUERY_KEY, "sync-settings"], saved);
    });

  // Collection belongs to the native worker. Renderer activity only refreshes
  // stored results; it never starts another automatic collector.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const refreshStoredResults = () => {
      if (
        document.visibilityState !== "hidden" &&
        document.documentElement.dataset.windowActive !== "false"
      )
        void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    };
    window.addEventListener(WINDOW_ACTIVITY_EVENT, refreshStoredResults);
    void listen("unified-usage-sync-updated", refreshStoredResults)
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener(WINDOW_ACTIVITY_EVENT, refreshStoredResults);
    };
  }, [queryClient]);

  useEffect(
    () => () => {
      const pending = loginRef.current;
      if (pending)
        void unifiedUsageApi
          .cancelLogin(pending.accountId, pending.loginId)
          .catch(() => undefined);
    },
    [],
  );

  const connect = (account: AnalyticsAccount) =>
    run(async () => {
      const result = await unifiedUsageApi.startLogin(account.id);
      const pending = { ...result, accountId: account.id };
      loginRef.current = pending;
      setLogin(pending);
      await deliverLoginLink(result.authUrl, t);
      try {
        await unifiedUsageApi.finishLogin(account.id, result.loginId);
        if (loginRef.current?.loginId === result.loginId) {
          loginRef.current = null;
          setLogin(null);
          await sync(account.id);
        }
      } finally {
        if (loginRef.current?.loginId === result.loginId) {
          loginRef.current = null;
          setLogin(null);
        }
      }
    });
  const cancelLogin = async () => {
    const pending = loginRef.current;
    if (!pending) return;
    try {
      await unifiedUsageApi.cancelLogin(pending.accountId, pending.loginId);
      loginRef.current = null;
      setLogin(null);
    } catch (cause) {
      setError(String(cause));
    }
  };
  const editAccount = (account: AnalyticsAccount | "new") => {
    setEditing(account);
    setName(account === "new" ? "" : account.name);
    setIntervalMinutes(
      account === "new" ? "0" : String(account.syncIntervalMinutes),
    );
  };
  const saveAccount = () =>
    run(async () => {
      if (editing === "new") await unifiedUsageApi.addAccount(name.trim());
      else if (editing)
        await unifiedUsageApi.updateAccount(
          editing.id,
          name.trim(),
          Number(interval),
        );
      setEditing(null);
    });
  const exportRecords = () =>
    run(async () => {
      const path = await save({
        defaultPath: "cc-switch-usage.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (path) {
        await unifiedUsageApi.export(path);
        toast.success(tx("exported", "Usage backup saved"));
      }
    });
  const importRecords = () =>
    run(async () => {
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      const result = await unifiedUsageApi.import(
        importAccount,
        path,
        importFormat,
      );
      setImportOpen(false);
      toast.success(
        `${tx("imported", "Records imported")}: ${number(result.imported)} · ${tx("skipped", "Duplicates skipped")}: ${number(result.skipped)}`,
      );
      if (result.warnings.length) setError(result.warnings.join("\n"));
    });
  const importExistingAccounts = () =>
    run(async () => {
      const result = await unifiedUsageApi.importExistingAccounts();
      setImportNotice(
        result.imported === 0 && result.skipped === 0
          ? tx(
              "noExistingAccounts",
              "No existing CC Switch ChatGPT accounts were found. Add them in Accounts first, or add a separate analytics account.",
            )
          : `${tx("accountLinksImported", "Account links imported")}: ${number(result.imported)} · ${tx("alreadyLinked", "Already linked")}: ${number(result.skipped)}`,
      );
    });

  const queryError =
    accountsQuery.error ??
    activeQuery.error ??
    syncSettingsQuery.error ??
    syncStatusQuery.error;
  const dimensionOptions = (dimension: "model" | "platform" | "feature") =>
    [
      ...new Set(
        (baseQuery.data?.breakdowns ?? [])
          .filter(
            (row) =>
              row.dimension === dimension &&
              !["", "unknown", "Unavailable", "unavailable"].includes(
                row.label,
              ),
          )
          .map((row) => row.label),
      ),
    ].sort();
  const managementTable = (
    <section className={PANEL}>
      <h2 className="mb-3 text-body font-semibold text-fg-1">
        {tx("comparison", "Account comparison")}
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-start text-body">
          <thead className="border-b border-border text-caption text-fg-3">
            <tr>
              {[
                tx("account", "Account"),
                tx("retainedAccountSummary", "Retained account summary"),
                tx("quota", "Quota snapshot"),
                tx("connection", "Connection & synchronization"),
                tx("manage", "Manage"),
              ].map((label) => (
                <th key={label} className="px-2 py-2 text-start font-medium">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {accounts.map((account, index) => {
              return (
                <tr
                  key={account.id}
                  className="border-b border-border last:border-0"
                >
                  <td className="max-w-[220px] px-2 py-4 align-top">
                    <div className="flex items-center gap-2 font-medium text-fg-1">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{
                          backgroundColor: COLORS[index % COLORS.length],
                        }}
                      />
                      {account.name}
                    </div>
                    <p className="mt-1 break-all text-caption text-fg-2">
                      {account.identity ?? tx("notIdentified", "Not connected")}
                    </p>
                    <p className="mt-1 text-caption text-fg-3">
                      {account.subscription ??
                        tx("planUnavailable", "Subscription not reported")}
                    </p>
                    {account.linkedAccountId && (
                      <p className="mt-1 text-caption text-fg-2">
                        {tx(
                          "existingAccountSource",
                          "Existing CC Switch account",
                        )}
                      </p>
                    )}
                  </td>
                  <td className="px-2 py-4 align-top">
                    <AccountSummary account={account} number={number} />
                  </td>
                  <td className="min-w-[170px] px-2 py-4 align-top">
                    <Quota account={account} locale={locale} />
                  </td>
                  <td className="max-w-[230px] px-2 py-4 align-top">
                    <span className="rounded-full bg-subtle px-2 py-0.5 text-caption text-fg-2">
                      {tx(
                        `status_${account.connectionStatus}`,
                        account.connectionStatus.replace(/_/g, " "),
                      )}
                    </span>
                    <p className="mt-2 text-caption text-fg-3">
                      {tx("lastSync", "Last sync")}:{" "}
                      {formatAnalyticsTimestamp(account.lastSyncAt, locale) ??
                        tx("never", "Never")}
                    </p>
                    <p className="mt-1 text-caption text-fg-3">
                      {tx("accountSchedule", "Refresh schedule")}:{" "}
                      {account.syncIntervalMinutes > 0
                        ? `${number(account.syncIntervalMinutes)} ${tx("minutes", "minutes")} · ${tx("accountOverride", "account override")}`
                        : tx("followGlobal", "Follow global")}
                    </p>
                    {account.lastError && (
                      <p className="mt-2 break-words text-caption text-warning-text">
                        {account.lastError}
                      </p>
                    )}
                    {account.linkedAccountId &&
                      account.connectionStatus === "reauth_required" && (
                        <p className="mt-2 text-caption text-fg-2">
                          {tx(
                            "manageExistingSignIn",
                            "Manage this sign-in in CC Switch's Accounts page, then refresh analytics.",
                          )}
                        </p>
                      )}
                    {account.linkedAccountId &&
                      account.connectionStatus === "disconnected" && (
                        <p className="mt-2 text-caption text-fg-2">
                          {tx(
                            "resumeExistingAnalytics",
                            "Import existing ChatGPT accounts again to resume analytics for this account.",
                          )}
                        </p>
                      )}
                  </td>
                  <td className="px-2 py-4 align-top">
                    <div className="flex flex-wrap gap-1">
                      <Button
                        variant="quiet"
                        size="compact"
                        disabled={busy}
                        onClick={() => editAccount(account)}
                      >
                        {tx("edit", "Edit")}
                      </Button>
                      {!account.linkedAccountId && (
                        <Button
                          variant="neutral"
                          size="compact"
                          disabled={busy}
                          onClick={() => void connect(account)}
                        >
                          {account.connectionStatus === "connected"
                            ? tx("reconnect", "Reconnect")
                            : tx("connect", "Connect")}
                        </Button>
                      )}
                      <Button
                        variant="quiet"
                        size="compact"
                        disabled={busy}
                        onClick={() => void run(() => sync(account.id))}
                      >
                        {tx("sync", "Sync now")}
                      </Button>
                      {((account.linkedAccountId &&
                        account.connectionStatus !== "disconnected") ||
                        account.connectionStatus === "connected") && (
                        <Button
                          variant="quiet"
                          size="compact"
                          disabled={busy}
                          onClick={() =>
                            void run(() =>
                              unifiedUsageApi.disconnectAccount(account.id),
                            )
                          }
                        >
                          {account.linkedAccountId
                            ? tx("unlinkAnalytics", "Unlink analytics")
                            : tx("disconnect", "Disconnect")}
                        </Button>
                      )}
                      <Button
                        variant="quiet"
                        size="compact"
                        disabled={busy}
                        onClick={() => setRemoving(account)}
                      >
                        {tx("delete", "Delete")}
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
  const refreshableAccounts = accounts.filter(
    (account) =>
      ["connected", "error"].includes(account.connectionStatus) &&
      account.identity !== null,
  );
  const lastSyncAt =
    refreshableAccounts.length &&
    refreshableAccounts.every((account) => account.lastSyncAt !== null)
      ? Math.min(...refreshableAccounts.map((account) => account.lastSyncAt!))
      : 0;
  const latestReportedDay = report.buckets
    .map(({ bucket }) => bucket.day)
    .filter((day): day is string => day !== null)
    .sort()
    .at(-1);
  const frequency =
    syncSettings?.intervalMinutes === 1
      ? tx("everyMinute", "Every minute")
      : syncSettings?.intervalMinutes === 5
        ? tx("everyFiveMinutes", "Every 5 minutes")
        : tx("everyTwoMinutes", "Every 2 minutes");
  const autoRefreshStatus = !syncSettings
    ? syncSettingsQuery.error
      ? tx(
          "backgroundSettingsUnavailable",
          "Background refresh settings unavailable",
        )
      : tx("backgroundSettingsLoading", "Reading background refresh settings…")
    : !syncSettings.enabled
      ? tx("backgroundRefreshOff", "Background refresh off")
      : `${tx("backgroundRefreshOn", "Background refresh on")} · ${frequency}`;
  const recentSyncAt = backgroundSync?.running
    ? backgroundSync.lastAttemptAt
    : (backgroundSync?.lastFinishedAt ?? backgroundSync?.lastAttemptAt);
  const recentSyncLabel =
    !backgroundSync?.running && backgroundSync?.lastFinishedAt
      ? tx("syncLastFinished", "Last sync finished")
      : tx("backgroundLastAttempt", "Last sync attempt");
  const officialTokenTotalsOnly =
    families.find((family) => family.key === familyKey)?.provenance ===
      "official" &&
    report.total.measuredTokens !== null &&
    report.total.requests === null &&
    report.total.cacheHitRate === null &&
    report.buckets.every(({ bucket }) => bucket.model === null);
  const prepareImport = () => {
    if (!accounts.length) setImportFormat("backup");
    setImportAccount(accountId || accounts[0]?.id || "");
    setImportOpen(true);
  };
  const detailRows = report.buckets.slice(
    detailPage * 30,
    (detailPage + 1) * 30,
  );
  const metricOf = (bucket: UsageBucket, names: string[], unit = "tokens") =>
    bucket.metrics.find(
      (metric) => names.includes(metric.metric) && metric.unit === unit,
    )?.value ?? null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <AppPageHeader
        icon={<ChartColumn className="h-5 w-5" strokeWidth={1.5} />}
        title={t("nav.usage", { defaultValue: "Usage statistics" })}
        titleExtra={
          <HelpTip
            title={tx(
              "partialTitle",
              "A measured, partial picture of your accounts",
            )}
          >
            {tx(
              "partialDescription",
              "Official account-service activity can include usage across devices, but does not establish complete ChatGPT Chat, voice, image, upload, or tool usage. Missing data means unavailable, not zero. Device activity remains in its own view.",
            )}
          </HelpTip>
        }
        actions={
          <div className="flex h-8 items-stretch overflow-hidden rounded-control border border-border-strong bg-surface">
            <Button
              variant="quiet"
              className="rounded-none"
              disabled={busy || !accounts.length}
              aria-label={tx("sync", "Sync now")}
              onClick={() => void run(() => sync())}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", busy && "animate-spin")}
              />
              {busy
                ? tx("syncing", "Synchronizing…")
                : lastSyncAt && Date.now() - lastSyncAt < 60000
                  ? tx("justSynced", "Just synchronized")
                  : tx("sync", "Sync now")}
            </Button>
            <Button
              variant="quiet"
              size="icon"
              className="rounded-none border-s border-border"
              aria-label={tx("manageAccounts", "Manage accounts")}
              onClick={() => setManageOpen(true)}
            >
              <Settings2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        }
      />
      {navigation}
      <div className="flex flex-wrap items-center gap-2 px-6 py-2.5">
        <select
          aria-label={tx("range", "Date range")}
          className={SELECT}
          value={days}
          onChange={(event) => setDays(event.target.value)}
        >
          <option value="all">{tx("allHistory", "All history")}</option>
          <option value="1">{tx("today", "Today")}</option>
          <option value="7">{tx("week", "7 days")}</option>
          <option value="30">{tx("month", "30 days")}</option>
        </select>
        <span className="mx-1 h-4 w-px bg-border" />
        <select
          aria-label={tx("account", "Account")}
          className={SELECT}
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
        >
          <option value="">{tx("allAccounts", "All accounts")}</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
        <select
          aria-label={tx("model", "Model")}
          className={SELECT}
          value={model}
          onChange={(event) => setModel(event.target.value)}
        >
          <option value="">{tx("all_model", "All models")}</option>
          {[
            ...new Set(
              (baseQuery.data?.usageBuckets ?? [])
                .map((bucket) => bucket.model)
                .filter((value): value is string => value !== null),
            ),
          ]
            .sort()
            .map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
        </select>
        <select
          aria-label={tx("sourceFamily", "Data source and coverage")}
          className={cn(SELECT, "max-w-[390px]")}
          value={familyKey ?? ""}
          onChange={(event) => setChosenFamily(event.target.value)}
        >
          {!families.length && (
            <option value="">
              {tx("noSourceData", "No source data reported")}
            </option>
          )}
          {families.map((family) => (
            <option key={family.key} value={family.key}>
              {familyLabel(family)}
            </option>
          ))}
        </select>
      </div>
      <div
        role="status"
        aria-label={tx("syncStatus", "Synchronization status")}
        className="space-y-1 px-6 pb-2 text-caption text-fg-3"
      >
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{autoRefreshStatus}</span>
          {backgroundSync?.running && (
            <span>
              {tx("backgroundRunning", "Synchronizing in background…")}
            </span>
          )}
          {recentSyncAt && (
            <span>{`${recentSyncLabel}: ${formatAnalyticsTimestamp(recentSyncAt, locale)}`}</span>
          )}
          {syncSettings?.enabled && backgroundSync?.nextDueAt && (
            <span>{`${tx("backgroundNextDue", "Next background check")}: ${formatAnalyticsTimestamp(backgroundSync.nextDueAt, locale)}`}</span>
          )}
          <span>
            {tx("refreshAccountCount", "Accounts eligible for refresh")}:{" "}
            {refreshableAccounts.length}
          </span>
          <span>
            {`${tx("allAccountsLastSuccess", "All-account last successful check")}: ${lastSyncAt ? formatAnalyticsTimestamp(lastSyncAt, locale) : tx("notAllChecked", "Not yet successful for all accounts")}`}
          </span>
          <span>
            {`${tx("latestReportedDay", "Latest reported activity (UTC)")}: ${latestReportedDay ?? tx("notReported", "Not reported")}`}
          </span>
          {report.total.measuredTokens !== null && (
            <span title={number(report.total.measuredTokens)}>
              {`${tx("exactReportedTokens", "Exact reported tokens")}: ${number(report.total.measuredTokens)}`}
            </span>
          )}
        </p>
        {officialTokenTotalsOnly && (
          <p>
            {tx(
              "officialTokenAvailability",
              "Official token totals are available. Model, request and cache details are not reported; an API cost requires model and input/output details. Refreshing cannot create fields the source does not provide.",
            )}
          </p>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-6 pt-1">
        {(error || queryError || importNotice) && (
          <div role="status" className="space-y-2">
            {importNotice && <Notice title={importNotice} />}
            {(error || queryError) && (
              <Notice
                tone="warning"
                title={tx("operationFailed", "Some data could not be updated")}
                actions={
                  <Button
                    variant="quiet"
                    size="compact"
                    onClick={() => void invalidate()}
                  >
                    {tx("retry", "Retry")}
                  </Button>
                }
              >
                <span className="whitespace-pre-wrap">
                  {error || String(queryError)}
                </span>
              </Notice>
            )}
          </div>
        )}
        {!accountsQuery.isLoading && !accounts.length && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-border bg-surface px-4 py-3">
            <div>
              <h2 className="text-body font-semibold text-fg-1">
                {tx("emptyTitle", "Bring your accounts into one view")}
              </h2>
              <p className="mt-1 text-caption text-fg-3">
                {tx(
                  "existingSessionsNotice",
                  "Existing accounts stay signed in; analytics links reuse CC Switch-managed sessions. Sync may refresh an existing session normally.",
                )}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="neutral"
                size="compact"
                onClick={() => void importExistingAccounts()}
              >
                {tx(
                  "importExistingAccounts",
                  "Import existing ChatGPT accounts",
                )}
              </Button>
              <Button
                variant="neutral"
                size="compact"
                onClick={() => editAccount("new")}
              >
                {tx("addAccount", "Add account")}
              </Button>
            </div>
          </div>
        )}
        <UnifiedThreadUsagePanel
          accounts={accounts}
          accountId={accountId}
          compact
          onViewDetails={() =>
            threadDetailsRef.current?.scrollIntoView({
              block: "start",
              behavior: "smooth",
            })
          }
        />
        <UnifiedUsageOverview
          total={{
            cost: report.total.cny,
            requests: report.total.requests,
            tokens: report.total.measuredTokens,
            hitRate: report.total.cacheHitRate,
          }}
          daily={dayValues}
          partial={{
            cost: report.total.partial,
            requests: report.total.requestsPartial,
            tokens: report.total.measuredTokensPartial,
            hitRate: report.total.cacheHitRatePartial,
          }}
          metric={overviewMetric}
          onMetricChange={setOverviewMetric}
          note={`${tx("costExplanation", "Token × model API price × exchange rate. This is an estimated API equivalent, not a ChatGPT subscription charge.")} ${costUnavailableReason} ${report.total.partial && report.total.pricedBuckets > 0 ? tx("partialCost", "Only part of the selected records can be priced.") : ""} ${pricing.fx.status === "unavailable" || pricing.fx.status === "loading" ? tx("fxUnavailable", "CNY conversion is unavailable until a real exchange rate is returned.") : pricing.fx.status === "stale" ? tx("fxStale", "Using the previous reported exchange rate; refresh is temporarily unavailable.") : ""} ${tx("reportedOnly", "Totals include only returned observations; * marks partial coverage.")}`}
          attribution={
            <p className="mt-1 flex flex-wrap items-center gap-x-1 text-caption text-fg-3">
              {pricing.usdToCny === null ? (
                tx(
                  "fxUnavailable",
                  "CNY conversion is unavailable until a real exchange rate is returned.",
                )
              ) : (
                <>
                  <span>
                    1 USD ={" "}
                    {new Intl.NumberFormat(locale, {
                      maximumFractionDigits: 6,
                    }).format(pricing.usdToCny)}{" "}
                    CNY · {tx("fxSource", "FX source")}
                  </span>
                  {fxProviderUrl ? (
                    <button
                      type="button"
                      className="underline underline-offset-2 hover:text-fg-1"
                      onClick={() =>
                        void settingsApi.openExternal(fxProviderUrl)
                      }
                    >
                      {pricing.fx.providerName ?? pricing.fx.source}
                    </button>
                  ) : (
                    <span>
                      {pricing.fx.providerName ?? pricing.fx.source ?? "—"}
                    </span>
                  )}
                  <span>
                    · {tx("fxFetchedAt", "Fetched at")}:{" "}
                    {formatAnalyticsTimestamp(pricing.fx.updatedAt, locale) ??
                      "—"}
                  </span>
                  {pricing.fx.status === "stale" && (
                    <span className="ms-1 rounded bg-warning-soft px-1.5 py-0.5 text-badge text-warning-text">
                      {tx("fxStaleBadge", "Previous rate")}
                    </span>
                  )}
                </>
              )}
            </p>
          }
        />
        {report.total.measuredTokens === null &&
          report.total.requests === null && (
            <p className="-mt-3 text-caption text-fg-3">
              {tx("noMetrics", "No measurable usage returned")}
            </p>
          )}
        <section className="shrink-0 overflow-hidden rounded-panel border border-border bg-surface">
          <PageTabs
            aria-label={tx("detailViews", "Analytics detail views")}
            className="h-11 px-4"
            items={[
              {
                value: "accounts" as const,
                label: tx("accountsTab", "Accounts"),
              },
              { value: "models" as const, label: tx("modelsTab", "Models") },
              {
                value: "details" as const,
                label: (
                  <span>
                    {tx("dailyRecords", "Daily records")}{" "}
                    <span className="ms-1 rounded bg-subtle px-1.5 text-caption text-fg-3">
                      {report.buckets.length}
                    </span>
                  </span>
                ),
              },
            ]}
            value={tab}
            onValueChange={setTab}
          />
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-body">
              <thead className="border-b border-border bg-subtle/40 text-caption text-fg-3">
                <tr>
                  {(tab === "accounts"
                    ? [
                        tx("account", "Account"),
                        tx("subscription", "Subscription"),
                        tx("totalRequests", "Requests"),
                        tx("measuredTokens", "Measured tokens"),
                        tx("cacheHitRate", "Cache hit rate"),
                        tx("apiEquivalent", "Estimated API equivalent"),
                        tx("lastSync", "Last sync"),
                      ]
                    : tab === "models"
                      ? [
                          tx("model", "Model"),
                          tx("totalRequests", "Requests"),
                          tx("measuredTokens", "Measured tokens"),
                          tx("cacheHitRate", "Cache hit rate"),
                          tx("apiEquivalent", "Estimated API equivalent"),
                        ]
                      : [
                          tx("utcDay", "UTC day"),
                          tx("account", "Account"),
                          tx("model", "Model"),
                          tx("recordType", "Record type"),
                          tx("totalRequests", "Requests"),
                          tx("measuredTokens", "Measured tokens"),
                          tx("cacheReadTokens", "Cache read tokens"),
                          tx("apiEquivalent", "Estimated API equivalent"),
                        ]
                  ).map((label) => (
                    <th key={label} className="h-9 px-4 text-start font-medium">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {tab === "accounts" &&
                  selectedAccounts.map((account) => {
                    const value = report.byAccount[account.id];
                    const lifetime =
                      typeof account.summary?.lifetimeTokens === "number" &&
                      Number.isSafeInteger(account.summary.lifetimeTokens) &&
                      account.summary.lifetimeTokens >= 0
                        ? account.summary.lifetimeTokens
                        : null;
                    return (
                      <tr key={account.id} className="hover:bg-subtle/40">
                        <td className="px-4 py-3">
                          <button
                            className="flex items-center gap-2 text-start font-medium text-fg-1 hover:underline"
                            onClick={() => setManageOpen(true)}
                          >
                            <span className="flex h-5 w-5 items-center justify-center rounded bg-subtle text-caption">
                              {account.name.slice(0, 1)}
                            </span>
                            {account.name}
                          </button>
                          <p className="mt-0.5 text-caption text-fg-3">
                            {account.linkedAccountId
                              ? tx(
                                  "existingAccountSource",
                                  "Existing CC Switch account",
                                )
                              : (account.identity ??
                                tx("notIdentified", "Not connected"))}
                          </p>
                          {lifetime !== null && (
                            <p
                              className="mt-0.5 text-caption tabular-nums text-fg-3"
                              title={`${number(lifetime)} Tokens · ${tx("lifetimeExcluded", "Excluded from the current date/model estimate; this is not a complete ChatGPT bill.")}`}
                            >
                              {tx("lifetimeSnapshot", "Lifetime snapshot")}:{" "}
                              {count(lifetime)} Tokens
                            </p>
                          )}
                          {value?.measuredTokens !== null &&
                            value?.measuredTokens !== undefined &&
                            value.requests === null &&
                            value.cacheHitRate === null &&
                            value.cny === null && (
                              <p className="mt-0.5 max-w-[260px] whitespace-normal text-caption text-fg-3">
                                {tx(
                                  "tokensOnlyAvailability",
                                  "Tokens reported; other metrics unavailable",
                                )}
                              </p>
                            )}
                        </td>
                        <td className="px-4 py-3 text-fg-2">
                          {account.subscription ?? "—"}
                        </td>
                        <td className="px-4 py-3 tabular-nums text-fg-2">
                          {count(value?.requests ?? null)}
                        </td>
                        <td
                          className="px-4 py-3 tabular-nums text-fg-1"
                          title={
                            value?.measuredTokens !== null &&
                            value?.measuredTokens !== undefined
                              ? number(value.measuredTokens)
                              : tx("notReported", "Not reported")
                          }
                        >
                          {count(value?.measuredTokens ?? null)}
                        </td>
                        <td className="px-4 py-3 tabular-nums text-fg-2">
                          {percent(value?.cacheHitRate ?? null)}
                        </td>
                        <td className="px-4 py-3 font-medium tabular-nums text-fg-1">
                          {money(value?.cny ?? null)}
                          {value?.partial && value.cny !== null ? " *" : ""}
                        </td>
                        <td className="px-4 py-3 text-caption text-fg-3">
                          {formatAnalyticsTimestamp(
                            account.lastSyncAt,
                            locale,
                          ) ?? "—"}
                          <p
                            className={cn(
                              "mt-0.5",
                              account.connectionStatus !== "connected" &&
                                "text-warning-text",
                            )}
                          >
                            {tx(
                              `status_${account.connectionStatus}`,
                              account.connectionStatus.replace(/_/g, " "),
                            )}
                          </p>
                          {account.lastError && (
                            <p className="mt-1 max-w-[250px] whitespace-normal text-warning-text">
                              {account.lastError}
                            </p>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                {tab === "models" &&
                  Object.entries(report.byModel).map(([label, value]) => (
                    <tr key={label} className="hover:bg-subtle/40">
                      <td className="px-4 py-3 font-mono text-caption text-fg-1">
                        {label || tx("notReported", "Not reported")}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-fg-2">
                        {count(value.requests)}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-fg-1">
                        {count(value.measuredTokens)}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-fg-2">
                        {percent(value.cacheHitRate)}
                      </td>
                      <td className="px-4 py-3 font-medium tabular-nums text-fg-1">
                        {money(value.cny)}
                        {value.partial && value.cny !== null ? " *" : ""}
                      </td>
                    </tr>
                  ))}
                {tab === "details" &&
                  detailRows.map((item) => (
                    <tr key={item.key} className="hover:bg-subtle/40">
                      <td className="px-4 py-3 tabular-nums text-fg-1">
                        {item.bucket.day ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-fg-2">
                        {accounts.find(
                          (account) => account.id === item.bucket.accountId,
                        )?.name ?? item.bucket.accountId}
                      </td>
                      <td className="px-4 py-3 font-mono text-caption text-fg-2">
                        {item.bucket.model ?? tx("notReported", "Not reported")}
                      </td>
                      <td className="px-4 py-3 text-caption text-fg-3">
                        {item.bucket.granularity === "day"
                          ? tx("dailyAggregate", "Daily aggregate")
                          : item.bucket.granularity === "event"
                            ? tx("eventAggregate", "Reported event aggregate")
                            : tx("lifetimeAggregate", "Lifetime snapshot")}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-fg-2">
                        {count(item.estimate.requests)}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-fg-1">
                        {count(item.estimate.measuredTokens)}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-fg-2">
                        {count(metricOf(item.bucket, ["cache_read_tokens"]))}
                      </td>
                      <td className="px-4 py-3 font-medium tabular-nums text-fg-1">
                        {money(item.estimate.cny)}
                        {item.estimate.partial && item.estimate.cny !== null
                          ? " *"
                          : ""}
                      </td>
                    </tr>
                  ))}
                {((tab === "accounts" && !selectedAccounts.length) ||
                  (tab === "models" && !Object.keys(report.byModel).length) ||
                  (tab === "details" && !report.buckets.length)) && (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-4 py-10 text-center text-caption text-fg-3"
                    >
                      {tx(
                        "noReturnedRecords",
                        "No records have been returned for this selection.",
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-caption text-fg-3">
            <span>
              {tx(
                "dailyDetailNotice",
                "These are reported usage aggregates, not individual request logs. Missing values are unavailable.",
              )}
            </span>
            {tab === "details" && report.buckets.length > 30 && (
              <div className="flex items-center gap-2">
                <Button
                  variant="quiet"
                  size="compact"
                  disabled={detailPage === 0}
                  onClick={() => setDetailPage((page) => page - 1)}
                >
                  {tx("previous", "Previous")}
                </Button>
                <span>
                  {detailPage + 1} / {Math.ceil(report.buckets.length / 30)}
                </span>
                <Button
                  variant="quiet"
                  size="compact"
                  disabled={(detailPage + 1) * 30 >= report.buckets.length}
                  onClick={() => setDetailPage((page) => page + 1)}
                >
                  {tx("next", "Next")}
                </Button>
              </div>
            )}
          </div>
        </section>
        <div className="shrink-0" ref={threadDetailsRef}>
          <UnifiedThreadUsagePanel accounts={accounts} accountId={accountId} />
        </div>
        <p className="text-caption text-fg-3">
          {tx(
            "compactCoverage",
            "Official account data has partial Chat coverage. Model, request, cache, or feature breakdowns appear only when actually reported. Different sources and coverage scopes remain separate.",
          )}
        </p>
      </div>
      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="max-w-[1100px]">
          <DialogHeader>
            <DialogTitle>{tx("manageAccounts", "Manage accounts")}</DialogTitle>
            <DialogDescription>
              {tx(
                "existingSessionsNotice",
                "Existing accounts stay signed in; analytics links reuse CC Switch-managed sessions. Sync may refresh an existing session normally.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-subtle p-3">
              <label className="flex items-center gap-2 text-body text-fg-2">
                <Switch
                  checked={syncSettings?.enabled ?? true}
                  disabled={busy || !syncSettings}
                  onCheckedChange={(enabled) => {
                    if (syncSettings)
                      void saveSyncSettings({ ...syncSettings, enabled });
                  }}
                />
                {tx(
                  "backgroundRefreshAll",
                  "Refresh all connected accounts in background",
                )}
              </label>
              <select
                aria-label={tx("refreshFrequency", "Refresh frequency")}
                className={SELECT}
                value={syncSettings?.intervalMinutes ?? 2}
                disabled={busy || !syncSettings}
                onChange={(event) => {
                  const value = Number(
                    event.target.value,
                  ) as AnalyticsSyncSettings["intervalMinutes"];
                  if (syncSettings)
                    void saveSyncSettings({
                      ...syncSettings,
                      intervalMinutes: value,
                    });
                }}
              >
                <option value={1}>{tx("everyMinute", "Every minute")}</option>
                <option value={2}>
                  {tx("everyTwoMinutes", "Every 2 minutes")}
                </option>
                <option value={5}>
                  {tx("everyFiveMinutes", "Every 5 minutes")}
                </option>
              </select>
            </div>
            <p className="text-caption text-fg-3">
              {tx(
                "backgroundRefreshScope",
                "Enabled by default while the application is running, including in the tray, on other pages, or unfocused. All connected accounts are refreshed independently of display filters. Fully quitting the app stops refresh; no system background service is installed.",
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="neutral"
                size="compact"
                disabled={busy}
                onClick={() => editAccount("new")}
              >
                <Plus className="h-3.5 w-3.5" />
                {tx("addAccount", "Add account")}
              </Button>
              <Button
                variant="neutral"
                size="compact"
                disabled={busy}
                onClick={() => void importExistingAccounts()}
              >
                <Link2 className="h-3.5 w-3.5" />
                {tx(
                  "importExistingAccounts",
                  "Import existing ChatGPT accounts",
                )}
              </Button>
              <Button
                variant="quiet"
                size="compact"
                disabled={busy}
                onClick={prepareImport}
              >
                <Upload className="h-3.5 w-3.5" />
                {tx("import", "Import")}
              </Button>
              <Button
                variant="quiet"
                size="compact"
                disabled={busy}
                onClick={() => void exportRecords()}
              >
                <Download className="h-3.5 w-3.5" />
                {tx("export", "Export")}
              </Button>
              <Button
                variant="quiet"
                size="compact"
                onClick={() => void pricing.refresh()}
              >
                {tx("refreshPricingFx", "Refresh prices and exchange rate")}
              </Button>
            </div>
            <div className="flex gap-2">
              {(["platform", "feature"] as const).map((dimension) => (
                <select
                  key={dimension}
                  aria-label={tx(dimension, dimension)}
                  className={SELECT}
                  value={dimension === "platform" ? platform : feature}
                  onChange={(event) =>
                    (dimension === "platform" ? setPlatform : setFeature)(
                      event.target.value,
                    )
                  }
                >
                  <option value="">
                    {tx(`all_${dimension}`, `All ${dimension}s`)}
                  </option>
                  {dimensionOptions(dimension).map((label) => (
                    <option key={label} value={label}>
                      {label}
                    </option>
                  ))}
                </select>
              ))}
            </div>
            <p className="text-caption text-fg-3">
              {tx("fxSource", "FX source")}:{" "}
              {pricing.fx.providerName ?? pricing.fx.source ?? "—"} · USD/CNY{" "}
              {pricing.usdToCny ?? "—"} · {tx("fxFetchedAt", "Fetched at")}:{" "}
              {formatAnalyticsTimestamp(pricing.fx.updatedAt, locale) ?? "—"}
            </p>
            {managementTable}
            <details className="text-caption text-fg-3">
              <summary>{tx("syncHistory", "Recent synchronization")}</summary>
              <ul className="mt-2 space-y-1">
                {data?.syncHistory.slice(0, 20).map((item) => (
                  <li key={item.id}>
                    {accounts.find((account) => account.id === item.accountId)
                      ?.name ?? item.accountId}{" "}
                    · {formatAnalyticsTimestamp(item.startedAt, locale)} ·{" "}
                    {item.status}
                    {item.error ? ` · ${item.error}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          </div>
          <DialogFooter>
            <Button variant="neutral" onClick={() => setManageOpen(false)}>
              {tx("done", "Done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={editing !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen && !busy) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing === "new"
                ? tx("addAccount", "Add account")
                : tx("editAccount", "Edit account")}
            </DialogTitle>
            <DialogDescription>
              {tx(
                "accountDescription",
                "Accounts are separate from provider switching. Connect through official sign-in after adding an account; credentials stay in the operating system keychain.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-6">
            <label className="block space-y-1.5 text-body text-fg-2">
              <span>{tx("accountName", "Account name")}</span>
              <Input
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </label>
          </div>
          <DialogFooter>
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              {tx("cancel", "Cancel")}
            </Button>
            <Button
              disabled={busy || !name.trim()}
              onClick={() => void saveAccount()}
            >
              {tx("save", "Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={importOpen}
        onOpenChange={(isOpen) => {
          if (!busy) setImportOpen(isOpen);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tx("import", "Import")}</DialogTitle>
            <DialogDescription>
              {tx(
                "importDescription",
                "Choose a JSON backup, normalized observations, or conversations.json extracted from your official ChatGPT export. Conversation contents are not retained. Export metadata is partial and provides message counts, not measured tokens.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-6">
            {importFormat !== "backup" && (
              <label className="block space-y-1.5 text-body text-fg-2">
                <span>{tx("account", "Account")}</span>
                <select
                  className={SELECT}
                  value={importAccount}
                  onChange={(event) => setImportAccount(event.target.value)}
                >
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="block space-y-1.5 text-body text-fg-2">
              <span>{tx("format", "File format")}</span>
              <select
                className={SELECT}
                value={importFormat}
                onChange={(event) =>
                  setImportFormat(event.target.value as AnalyticsImportFormat)
                }
              >
                <option value="chatgpt_export">
                  {tx("chatgptExport", "ChatGPT conversations.json")}
                </option>
                <option value="backup">
                  {tx("backup", "CC Switch usage backup")}
                </option>
                <option value="observations">
                  {tx("observations", "Normalized observations")}
                </option>
              </select>
            </label>
          </div>
          <DialogFooter>
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() => setImportOpen(false)}
            >
              {tx("cancel", "Cancel")}
            </Button>
            <Button
              disabled={busy || (importFormat !== "backup" && !importAccount)}
              onClick={() => void importRecords()}
            >
              {tx("chooseFile", "Choose file and import")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={login !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) void cancelLogin();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {tx("completeSignIn", "Complete ChatGPT sign-in")}
            </DialogTitle>
            <DialogDescription>
              {tx(
                "signInDescription",
                "Sign in to the intended account in your browser. This authorization belongs only to this analytics profile. Your existing Codex and CC Switch provider sessions are preserved.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 px-6 text-body">
            <p className="flex items-center gap-2 text-fg-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {tx("waitingSignIn", "Waiting for official authorization…")}
            </p>
            {login && (
              <Button
                variant="neutral"
                onClick={() => void settingsApi.openExternal(login.authUrl)}
              >
                {tx("openSignIn", "Open sign-in page")}
              </Button>
            )}
          </div>
          <DialogFooter>
            <Button variant="quiet" onClick={() => void cancelLogin()}>
              {tx("cancel", "Cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        isOpen={removing !== null}
        title={tx("deleteAccount", "Delete account and usage history?")}
        message={tx(
          "deleteDescription",
          "This permanently removes only this analytics account and its stored records. Existing CC Switch sign-ins and providers remain signed in. Export a backup first if needed, or disconnect/unlink analytics to keep history.",
        )}
        confirmText={tx("delete", "Delete")}
        pending={busy}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing)
            void run(async () => {
              await unifiedUsageApi.removeAccount(removing.id);
              if (accountId === removing.id) setAccountId("");
              setRemoving(null);
            });
        }}
      />
    </div>
  );
}
