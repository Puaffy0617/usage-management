import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartColumn,
  Download,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
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
import type {
  AnalyticsAccount,
  AnalyticsImportFormat,
  AnalyticsLogin,
  MetricAggregate,
} from "@/types/unifiedUsage";
import {
  buildAccountTrend,
  formatAnalyticsTimestamp,
  metricGroupKey,
  safeMetricSum,
  utcRange,
} from "./unifiedUsageData";

const QUERY_KEY = ["unified-usage"] as const;
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
  const [days, setDays] = useState("30");
  const [accountId, setAccountId] = useState("");
  const [model, setModel] = useState("");
  const [platform, setPlatform] = useState("");
  const [feature, setFeature] = useState("");
  const [chosenGroup, setChosenGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const lastAutoAttemptAt = useRef(new Map<string, number>());
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

  const accountsQuery = useQuery({
    queryKey: [...QUERY_KEY, "accounts"],
    queryFn: unifiedUsageApi.listAccounts,
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
    retry: false,
  });
  const activeQuery = hasDimensions ? scopedQuery : baseQuery;
  const data = activeQuery.data;
  const selectedAccounts = accounts.filter(
    (account) => !accountId || account.id === accountId,
  );
  const groups = useMemo(() => {
    const result = new Map<string, MetricAggregate>();
    for (const row of data?.totals ?? []) result.set(metricGroupKey(row), row);
    return [...result.entries()].sort(
      ([, a], [, b]) =>
        ["official", "local", "estimated"].indexOf(a.provenance) -
        ["official", "local", "estimated"].indexOf(b.provenance),
    );
  }, [data]);
  const groupKey = groups.some(([key]) => key === chosenGroup)
    ? chosenGroup
    : (groups[0]?.[0] ?? "");
  const group = groups.find(([key]) => key === groupKey)?.[1];
  const totals = (data?.totals ?? []).filter(
    (row) => metricGroupKey(row) === groupKey,
  );
  const total = safeMetricSum(totals.map((row) => row.value));
  const trend = useMemo(
    () => buildAccountTrend(data?.daily ?? [], groupKey),
    [data, groupKey],
  );
  const originLabel = (origin: string) => {
    if (["official", "officially_reported"].includes(origin))
      return tx("official", "Officially reported");
    if (["local", "locally_measured"].includes(origin))
      return tx("local", "Locally measured");
    if (origin === "estimated") return tx("estimated", "Estimated");
    return origin;
  };
  const metricLabel = (row: MetricAggregate) => {
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
    return `${row.metric.replace(/_/g, " ")} · ${row.unit} · ${originLabel(row.provenance)} · ${coverage} · ${source}`;
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
    if (result.errors.length) setError(result.errors.join("\n"));
  };

  // Only opted-in, due accounts synchronize while this page is visible.
  // A timer is not a second collector and stops when the page is unmounted.
  useEffect(() => {
    const synchronizeDueAccounts = async () => {
      if (busyRef.current || document.visibilityState === "hidden") return;
      const now = Date.now();
      const due = accounts.filter(
        (account) =>
          ["connected", "error"].includes(account.connectionStatus) &&
          account.identity !== null &&
          account.syncIntervalMinutes > 0 &&
          now -
            Math.max(
              account.lastSyncAt ?? 0,
              lastAutoAttemptAt.current.get(account.id) ?? 0,
            ) >=
            account.syncIntervalMinutes * 60_000,
      );
      if (!due.length) return;
      await run(async () => {
        for (const account of due) {
          // Record attempts before awaiting: a transient failure must wait for
          // the configured interval, while other accounts can still refresh.
          lastAutoAttemptAt.current.set(account.id, Date.now());
          try {
            await sync(account.id);
          } catch (cause) {
            setError((previous) =>
              [previous, String(cause)].filter(Boolean).join("\n"),
            );
          }
        }
      });
    };
    const timer = window.setInterval(
      () => void synchronizeDueAccounts(),
      60_000,
    );
    return () => window.clearInterval(timer);
    // Account metadata is refreshed after each synchronization, including failures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts]);

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

  const queryError = accountsQuery.error ?? activeQuery.error;
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
  const breakdown = (dimension: "model" | "platform" | "feature") => {
    const result = new Map<string, number>();
    for (const row of data?.breakdowns ?? []) {
      if (row.dimension !== dimension || metricGroupKey(row) !== groupKey)
        continue;
      result.set(row.label, (result.get(row.label) ?? 0) + row.value);
    }
    const rows = [...result.entries()].sort(([, a], [, b]) => b - a);
    return rows.every(([label]) =>
      ["", "unknown", "Unavailable", "unavailable"].includes(label),
    )
      ? []
      : rows;
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <AppPageHeader
        icon={<ChartColumn className="h-5 w-5" strokeWidth={1.5} />}
        title={tx("accountAnalytics", "Account analytics")}
        actions={
          <>
            <Button
              variant="quiet"
              size="compact"
              onClick={() => void exportRecords()}
              disabled={busy}
            >
              <Download className="h-3.5 w-3.5" />
              {tx("export", "Export")}
            </Button>
            <Button
              variant="neutral"
              size="compact"
              disabled={busy}
              onClick={() => {
                if (!accounts.length) setImportFormat("backup");
                setImportAccount(accountId || accounts[0]?.id || "");
                setImportOpen(true);
              }}
            >
              <Upload className="h-3.5 w-3.5" />
              {tx("import", "Import")}
            </Button>
            <Button
              variant="neutral"
              size="compact"
              disabled={busy || accounts.length === 0}
              onClick={() => void run(() => sync())}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {tx("sync", "Sync now")}
            </Button>
            <Button
              variant="solid"
              size="compact"
              disabled={busy}
              onClick={() => editAccount("new")}
            >
              <Plus className="h-3.5 w-3.5" />
              {tx("addAccount", "Add account")}
            </Button>
          </>
        }
      />
      {navigation}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="neutral"
            size="compact"
            disabled={busy}
            onClick={() => void importExistingAccounts()}
          >
            <Link2 className="h-3.5 w-3.5" />
            {tx("importExistingAccounts", "Import existing ChatGPT accounts")}
          </Button>
          <p className="min-w-[240px] flex-1 text-caption text-fg-2">
            {tx(
              "existingSessionsNotice",
              "Existing accounts stay signed in; analytics links reuse CC Switch-managed sessions. Sync may refresh an existing session normally.",
            )}
          </p>
        </div>
        <Notice
          title={tx(
            "partialTitle",
            "A measured, partial picture of your accounts",
          )}
        >
          {tx(
            "partialDescription",
            "Official account-service activity can include usage across devices, but does not establish complete ChatGPT Chat, voice, image, upload, or tool usage. Missing data means unavailable, not zero. Device activity remains in its own view.",
          )}{" "}
          <button
            type="button"
            className="underline"
            onClick={() =>
              void settingsApi.openExternal(
                "https://learn.chatgpt.com/docs/app-server",
              )
            }
          >
            {tx("sourceDocumentation", "Official source documentation")}
          </button>
        </Notice>
        <div role="status">
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
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={tx("range", "Date range")}
            className={SELECT}
            value={days}
            onChange={(event) => setDays(event.target.value)}
          >
            <option value="1">{tx("today", "Today")}</option>
            <option value="7">{tx("week", "7 days")}</option>
            <option value="30">{tx("month", "30 days")}</option>
            <option value="all">{tx("allHistory", "All history")}</option>
          </select>
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
          {(["model", "platform", "feature"] as const).map((dimension) => {
            const value =
              dimension === "model"
                ? model
                : dimension === "platform"
                  ? platform
                  : feature;
            const change =
              dimension === "model"
                ? setModel
                : dimension === "platform"
                  ? setPlatform
                  : setFeature;
            return (
              <select
                key={dimension}
                aria-label={tx(dimension, dimension)}
                className={SELECT}
                value={value}
                onChange={(event) => change(event.target.value)}
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
            );
          })}
          <span className="text-caption text-fg-3">
            {tx("utcDates", "Dates are UTC")}
          </span>
        </div>
        {accountsQuery.isLoading || activeQuery.isLoading ? (
          <p className="flex items-center gap-2 text-body text-fg-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            {tx("loading", "Loading account history…")}
          </p>
        ) : accounts.length === 0 ? (
          <section className={`${PANEL} py-12 text-center`}>
            <h2 className="text-title text-fg-1">
              {tx("emptyTitle", "Bring your accounts into one view")}
            </h2>
            <p className="mx-auto mt-2 max-w-lg text-body text-fg-2">
              {tx(
                "emptyDescription",
                "Add two or more accounts, connect each through the official Codex sign-in, or import your own usage records. Statistics appear only when real data is available.",
              )}
            </p>
            <Button
              className="mt-5"
              variant="neutral"
              onClick={() => editAccount("new")}
            >
              {tx("addAccount", "Add account")}
            </Button>
          </section>
        ) : (
          <>
            {groups.length > 0 && (
              <label className="flex flex-col gap-1.5 text-caption text-fg-2">
                {tx("metricDefinition", "Metric and coverage")}
                <select
                  aria-label={tx("metricDefinition", "Metric and coverage")}
                  className={`${SELECT} max-w-full`}
                  value={groupKey}
                  onChange={(event) => setChosenGroup(event.target.value)}
                >
                  {groups.map(([key, row]) => (
                    <option key={key} value={key}>
                      {metricLabel(row)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <section className="grid gap-3 sm:grid-cols-3">
              <div className={PANEL}>
                <p className="text-caption text-fg-2">
                  {tx("combined", "Combined reported activity")}
                </p>
                <p className="mt-2 text-3xl font-semibold tabular-nums text-fg-1">
                  {group
                    ? total === null
                      ? tx("numericRange", "Outside supported numeric range")
                      : number(total)
                    : "—"}{" "}
                  <span className="text-body font-normal text-fg-2">
                    {group?.unit}
                  </span>
                </p>
                <p className="mt-2 text-caption text-fg-3">
                  {group
                    ? `${group.metric} · ${originLabel(group.provenance)}`
                    : tx("noMetrics", "No measurable usage returned")}
                </p>
              </div>
              <div className={PANEL}>
                <p className="text-caption text-fg-2">
                  {tx("accountsReporting", "Accounts reporting this metric")}
                </p>
                <p className="mt-2 text-3xl font-semibold tabular-nums text-fg-1">
                  {new Set(totals.map((row) => row.accountId)).size}{" "}
                  <span className="text-body font-normal text-fg-2">
                    / {selectedAccounts.length}
                  </span>
                </p>
                <p className="mt-2 text-caption text-fg-3">
                  {tx(
                    "partialTotal",
                    "Combined totals include returned observations only.",
                  )}
                </p>
              </div>
              <div className={PANEL}>
                <p className="text-caption text-fg-2">
                  {tx("retainedRecords", "Records in this selection")}
                </p>
                <p className="mt-2 text-3xl font-semibold tabular-nums text-fg-1">
                  {data ? number(data.recordCount) : "—"}
                </p>
                <p className="mt-2 text-caption text-fg-3">
                  {tx(
                    "separateMetrics",
                    "Different units, sources, and coverage stay separate.",
                  )}
                </p>
              </div>
            </section>
            <section className={PANEL}>
              <h2 className="text-body font-semibold text-fg-1">
                {tx("trend", "Daily activity by account")}
              </h2>
              <p className="mt-1 text-caption text-fg-3">
                {tx(
                  "missingDays",
                  "Gaps are days without reported observations. Lifetime summaries are shown separately.",
                )}
              </p>
              {trend.length > 0 ? (
                <div
                  className="mt-4 h-64"
                  aria-label={tx("trend", "Daily activity by account")}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={trend}
                      margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
                    >
                      <CartesianGrid
                        stroke="var(--chart-grid)"
                        strokeDasharray="3 3"
                        vertical={false}
                      />
                      <XAxis dataKey="date" fontSize={11} tickLine={false} />
                      <YAxis
                        fontSize={11}
                        tickLine={false}
                        width={64}
                        tickFormatter={(value: number) => number(value)}
                      />
                      <Tooltip
                        formatter={(value) =>
                          typeof value === "number" ? number(value) : value
                        }
                        contentStyle={{
                          background: "var(--bg-card)",
                          borderColor: "hsl(var(--border))",
                          borderRadius: 8,
                        }}
                      />
                      {selectedAccounts.map((account, index) => (
                        <Line
                          key={account.id}
                          dataKey={account.id}
                          name={account.name}
                          stroke={COLORS[index % COLORS.length]}
                          strokeWidth={2}
                          dot={{ r: 3 }}
                          connectNulls={false}
                          isAnimationActive={false}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="py-10 text-center text-body text-fg-3">
                  {tx(
                    "noDaily",
                    "Daily history has not been reported for this metric.",
                  )}
                </p>
              )}
            </section>
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
                        tx("selectedMetric", "Selected metric"),
                        tx("quota", "Quota snapshot"),
                        tx("connection", "Connection & synchronization"),
                        tx("manage", "Manage"),
                      ].map((label) => (
                        <th
                          key={label}
                          className="px-2 py-2 text-start font-medium"
                        >
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {selectedAccounts.map((account, index) => {
                      const rows = totals.filter(
                        (row) => row.accountId === account.id,
                      );
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
                                  backgroundColor:
                                    COLORS[index % COLORS.length],
                                }}
                              />
                              {account.name}
                            </div>
                            <p className="mt-1 break-all text-caption text-fg-2">
                              {account.identity ??
                                tx("notIdentified", "Not connected")}
                            </p>
                            <p className="mt-1 text-caption text-fg-3">
                              {account.subscription ??
                                tx(
                                  "planUnavailable",
                                  "Subscription not reported",
                                )}
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
                          <td className="px-2 py-4 align-top tabular-nums text-fg-1">
                            {rows.length
                              ? `${number(rows.reduce((sum, row) => sum + row.value, 0))} ${group?.unit}`
                              : "—"}
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
                              {formatAnalyticsTimestamp(
                                account.lastSyncAt,
                                locale,
                              ) ?? tx("never", "Never")}
                            </p>
                            {account.lastError && (
                              <p className="mt-2 break-words text-caption text-warning-text">
                                {account.lastError}
                              </p>
                            )}
                            {account.linkedAccountId &&
                              account.connectionStatus ===
                                "reauth_required" && (
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
                                      unifiedUsageApi.disconnectAccount(
                                        account.id,
                                      ),
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
            <div className="grid gap-3 lg:grid-cols-3">
              {(["model", "platform", "feature"] as const).map((dimension) => {
                const rows = breakdown(dimension);
                const maximum = rows.reduce(
                  (max, [, value]) => Math.max(max, value),
                  1,
                );
                return (
                  <section key={dimension} className={PANEL}>
                    <h2 className="text-body font-semibold capitalize text-fg-1">
                      {tx(`by_${dimension}`, `By ${dimension}`)}
                    </h2>
                    {rows.length ? (
                      <ul className="mt-4 space-y-3">
                        {rows.map(([label, value]) => (
                          <li key={label} className="text-caption">
                            <div className="flex justify-between gap-2 text-fg-2">
                              <span className="break-all">
                                {[
                                  "",
                                  "unknown",
                                  "Unavailable",
                                  "unavailable",
                                ].includes(label)
                                  ? tx("notReported", "Not reported")
                                  : label}
                              </span>
                              <span className="shrink-0 tabular-nums">
                                {number(value)} {group?.unit}
                              </span>
                            </div>
                            <div className="mt-1 h-1 rounded-full bg-subtle">
                              <div
                                className="h-full rounded-full bg-action"
                                style={{ width: `${(value / maximum) * 100}%` }}
                              />
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-4 text-caption text-fg-3">
                        {tx(
                          "noBreakdown",
                          "This source has not reported this breakdown.",
                        )}
                      </p>
                    )}
                  </section>
                );
              })}
            </div>
            <section className={PANEL}>
              <h2 className="text-body font-semibold text-fg-1">
                {tx("syncHistory", "Recent synchronization")}
              </h2>
              {data?.syncHistory.length ? (
                <ul className="mt-3 divide-y divide-border">
                  {data.syncHistory.slice(0, 20).map((item) => (
                    <li
                      key={item.id}
                      className="flex flex-wrap justify-between gap-2 py-2 text-caption text-fg-2"
                    >
                      <span>
                        {accounts.find(
                          (account) => account.id === item.accountId,
                        )?.name ?? item.accountId}{" "}
                        · {item.source} · {item.status}
                      </span>
                      <span>
                        {formatAnalyticsTimestamp(item.startedAt, locale)} ·{" "}
                        {number(item.imported)} {tx("records", "records")}
                      </span>
                      {item.error && (
                        <span className="w-full text-warning-text">
                          {item.error}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-caption text-fg-3">
                  {tx("noSyncHistory", "No synchronization has completed yet.")}
                </p>
              )}
            </section>
          </>
        )}
      </div>

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
            {editing !== "new" && (
              <label className="block space-y-1.5 text-body text-fg-2">
                <span>{tx("frequency", "Automatic synchronization")}</span>
                <select
                  className={SELECT}
                  value={interval}
                  onChange={(event) => setIntervalMinutes(event.target.value)}
                >
                  <option value="0">{tx("manual", "Manual only")}</option>
                  <option value="15">
                    {tx("every15", "Every 15 minutes")}
                  </option>
                  <option value="60">{tx("every60", "Every hour")}</option>
                  <option value="360">{tx("every360", "Every 6 hours")}</option>
                </select>
                <p className="text-caption text-fg-3">
                  {tx(
                    "syncVisibility",
                    "Automatic synchronization runs only while this analytics page is open and visible.",
                  )}
                </p>
              </label>
            )}
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
