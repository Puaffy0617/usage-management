import { Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { unifiedUsageApi } from "@/lib/api/unifiedUsage";
import { useUnifiedUsagePricing } from "@/hooks/useUnifiedUsagePricing";
import { Button } from "@/components/ui/button";
import type { AnalyticsAccount, ThreadUsageRecord } from "@/types/unifiedUsage";
import {
  formatAnalyticsTimestamp,
  formatApiEquivalentCny,
} from "./unifiedUsageData";
import {
  reportedThreadCounter as measured,
  summarizeThreadUsage,
} from "./unifiedThreadUsageData";

/** This independent lifetime view never contributes to the dated usage cards. */
export function UnifiedThreadUsagePanel({
  accounts,
  accountId = "",
  compact = false,
  onViewDetails,
}: {
  accounts: AnalyticsAccount[];
  accountId?: string;
  compact?: boolean;
  onViewDetails?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const tx = (key: string, defaultValue: string) =>
    t(`unifiedThreads.${key}`, { defaultValue });
  const locale = i18n.language || "en";
  const query = useQuery({
    queryKey: ["unified-usage", "threads"],
    queryFn: () => unifiedUsageApi.threadDashboard(),
    // The compact observer shares the full table's cache and read-only timer.
    refetchInterval: compact ? false : 30_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const pricing = useUnifiedUsagePricing();
  // Authentication proves accessibility, not billing ownership. Detect shared
  // threads before applying any display filter so it cannot hide ambiguity.
  const {
    records,
    ambiguous,
    usd,
    partial,
    tokens,
    tokensPartial,
    hasAmbiguity,
  } = summarizeThreadUsage(query.data?.records ?? [], accountId);
  const converted =
    usd !== null && pricing.usdToCny !== null ? usd * pricing.usdToCny : null;
  const cny =
    converted !== null &&
    Number.isFinite(converted) &&
    converted <= Number.MAX_SAFE_INTEGER &&
    (usd === 0 || converted > 0)
      ? converted
      : null;
  const count = (value: number | null | undefined) =>
    measured(value) ? value.toLocaleString(locale) : "—";
  const dollars = (value: number | null) =>
    value === null
      ? "—"
      : value > 0 && value < 0.01
        ? "<$0.01"
        : new Intl.NumberFormat(locale, {
            style: "currency",
            currency: "USD",
            currencyDisplay: "narrowSymbol",
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }).format(value);
  const serverDollars = (value: number | null | undefined) =>
    measured(value) ? dollars(value / 1_000_000) : "—";
  const name = (id: string) =>
    accounts.find((account) => account.id === id)?.name ?? id;
  const state = (record: ThreadUsageRecord) =>
    record.snapshot && record.status !== "available"
      ? tx("retained", "Retained snapshot; latest check did not succeed")
      : record.status === "available"
        ? tx("available", "Official snapshot reported")
        : record.status === "unavailable"
          ? tx("unavailable", "No supported thread snapshot returned")
          : tx("error", "Latest check failed");

  if (compact)
    return (
      <section
        aria-label={tx(
          "summaryTitle",
          "Official discovered threads · Lifetime subtotal",
        )}
        className="shrink-0 rounded-panel border border-border bg-surface px-4 py-3"
      >
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-caption text-fg-2">
          <h2 className="text-body font-semibold text-fg-1">
            {tx(
              "summaryTitle",
              "Official discovered threads · Lifetime subtotal",
            )}
          </h2>
          <span>
            {tx("serverEstimate", "Server-reported USD estimate")}:{" "}
            <strong className="tabular-nums text-fg-1">
              {dollars(usd)}
              {partial && usd !== null ? " *" : ""}
            </strong>
          </span>
          <span>
            {tx("cnyEquivalent", "CNY conversion")}:{" "}
            <strong className="tabular-nums text-fg-1">
              {formatApiEquivalentCny(cny, locale)}
              {partial && cny !== null ? " *" : ""}
            </strong>
            {pricing.fx.status === "stale"
              ? ` · ${tx("staleFx", "Previous exchange rate")}`
              : ""}
          </span>
          <span title={count(tokens)}>
            {tx("reportedThreadTokens", "Reported thread tokens")}:{" "}
            <strong className="tabular-nums text-fg-1">
              {count(tokens)}
              {tokensPartial && tokens !== null ? " *" : ""}
            </strong>
          </span>
          {onViewDetails && (
            <Button
              variant="quiet"
              size="compact"
              className="ms-auto"
              onClick={onViewDetails}
            >
              {tx("viewDetails", "View thread amounts and details")}
            </Button>
          )}
        </div>
        <p className="mt-1.5 text-caption text-fg-3">
          {tx(
            "summaryScope",
            "Partial lifetime snapshots only; separate from the daily token total below and not a complete account bill. * marks unavailable, stale or excluded snapshots.",
          )}
        </p>
        {hasAmbiguity && (
          <p className="mt-1 text-caption text-warning-text">
            {accountId
              ? tx(
                  "accessibleWarning",
                  "This account can access a thread also visible to another account. Its snapshot is shown for accessibility only; billing ownership is unverified.",
                )
              : tx(
                  "ambiguousWarning",
                  "Threads visible under multiple accounts are excluded from the combined USD subtotal. Their snapshots remain visible below; billing ownership is unverified.",
                )}
          </p>
        )}
        {usd !== null && pricing.usdToCny === null && (
          <p className="mt-1 text-caption text-fg-3">
            {tx(
              "noFx",
              "The reported USD estimate is available; CNY conversion requires a real exchange rate.",
            )}
          </p>
        )}
        {usd === null && (
          <p className="mt-1 text-caption text-fg-3">
            {query.isLoading
              ? tx("loading", "Reading stored thread snapshots…")
              : tx(
                  "summaryUnavailable",
                  "No unambiguous server-reported thread USD subtotal is available for this selection. Unsupported or inaccessible snapshots remain unavailable, not zero.",
                )}
          </p>
        )}
        {query.error && (
          <p className="mt-1 text-caption text-warning-text">
            {tx("readError", "Stored thread snapshots could not be read")}:{" "}
            {String(query.error)}
          </p>
        )}
      </section>
    );

  return (
    <section
      aria-label={tx("title", "Discovered threads · Lifetime snapshots")}
      className="shrink-0 overflow-hidden rounded-panel border border-border bg-surface"
    >
      <div className="space-y-2 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-body font-semibold text-fg-1">
            {tx("title", "Discovered threads · Lifetime snapshots")}
          </h2>
          <span className="rounded bg-subtle px-2 py-0.5 text-caption text-fg-3">
            {tx(
              "partialScope",
              "Partial coverage · separate from daily activity",
            )}
          </span>
        </div>
        <p className="text-caption text-fg-3">
          {tx(
            "scope",
            "Official account-authenticated snapshots for locally discovered thread IDs. These cumulative snapshots have no reported date and do not enter the daily heatmap, main totals, or model-price estimates. An accessible thread does not establish which account was billed.",
          )}
        </p>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-caption text-fg-2">
          <span>
            {tx("serverEstimate", "Server-reported USD estimate")}:{" "}
            <strong className="tabular-nums text-fg-1">
              {dollars(usd)}
              {partial && usd !== null ? " *" : ""}
            </strong>
          </span>
          <span>
            {tx("cnyEquivalent", "CNY conversion")}:{" "}
            <strong className="tabular-nums text-fg-1">
              {formatApiEquivalentCny(cny, locale)}
              {partial && cny !== null ? " *" : ""}
            </strong>
            {pricing.fx.status === "stale"
              ? ` · ${tx("staleFx", "Previous exchange rate")}`
              : ""}
          </span>
          <span>
            {tx("checkedContexts", "Checked account/thread contexts")}:{" "}
            {records.length} ·{" "}
            {tx("candidates", "Discovered candidate IDs (all accounts)")}:{" "}
            {query.data?.candidateCount ?? "—"}
          </span>
        </div>
        <p className="text-caption text-fg-3">
          {tx(
            "estimateNotice",
            "The USD amount is returned by the official service, not inferred from credits or configured API prices, and is not a subscription charge. * marks a subtotal with unavailable or excluded snapshots. Date and model filters above do not apply to this lifetime view.",
          )}
        </p>
        {hasAmbiguity && (
          <p className="text-caption text-warning-text">
            {accountId
              ? tx(
                  "accessibleWarning",
                  "This account can access a thread also visible to another account. Its snapshot is shown for accessibility only; billing ownership is unverified.",
                )
              : tx(
                  "ambiguousWarning",
                  "Threads visible under multiple accounts are excluded from the combined USD subtotal. Their snapshots remain visible below; billing ownership is unverified.",
                )}
          </p>
        )}
        {query.error && (
          <p className="text-caption text-warning-text">
            {tx("readError", "Stored thread snapshots could not be read")}:{" "}
            {String(query.error)}
          </p>
        )}
      </div>
      {!records.length ? (
        <p className="px-4 py-5 text-caption text-fg-3">
          {query.isLoading
            ? tx("loading", "Reading stored thread snapshots…")
            : tx(
                "empty",
                "No supported thread snapshots have been returned yet. Account refresh checks a bounded set of locally discovered IDs through the official service; unsupported or inaccessible threads remain unavailable. This does not mean zero usage.",
              )}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap text-start text-caption">
            <thead className="border-b border-border bg-subtle/40 text-fg-3">
              <tr>
                {[
                  tx("accountThread", "Account / thread"),
                  tx("model", "Model"),
                  tx("freshInput", "Net-new input"),
                  tx("input", "Input"),
                  tx("cachedInput", "Cached input"),
                  tx("output", "Output"),
                  tx("total", "Total tokens"),
                  tx("serverEstimate", "Server-reported USD estimate"),
                  tx("status", "Status / check time"),
                ].map((label) => (
                  <th key={label} className="h-9 px-3 font-medium">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {records.map((record) => {
                const groups = record.snapshot?.groups.length
                  ? record.snapshot.groups
                  : [null];
                return (
                  <Fragment key={`${record.accountId}:${record.threadId}`}>
                    {groups.map((group, index) => (
                      <tr key={index} className="hover:bg-subtle/40">
                        {index === 0 && (
                          <td
                            rowSpan={groups.length}
                            className="px-3 py-3 align-top text-fg-2"
                          >
                            <p className="font-medium">
                              {name(record.accountId)}
                            </p>
                            <p
                              className="mt-0.5 max-w-[180px] truncate font-mono"
                              title={record.threadId}
                            >
                              {record.threadId}
                            </p>
                            {ambiguous(record) && (
                              <p className="mt-1 max-w-[180px] whitespace-normal text-warning-text">
                                {tx(
                                  "ambiguous",
                                  "Shared accessibility; owner unverified",
                                )}
                              </p>
                            )}
                          </td>
                        )}
                        <td className="px-3 py-3 font-mono text-fg-2">
                          {group?.model ?? "—"}
                          {group?.reasoningEffort || group?.speed ? (
                            <p className="mt-0.5 text-fg-3">
                              {[group.reasoningEffort, group.speed]
                                .filter(Boolean)
                                .join(" · ")}
                            </p>
                          ) : null}
                        </td>
                        {[
                          group?.netNewInputTokens,
                          group?.inputTokens,
                          group?.cachedInputTokens,
                          group?.outputTokens,
                          group?.totalTokens,
                        ].map((value, column) => (
                          <td
                            key={column}
                            className="px-3 py-3 tabular-nums text-fg-2"
                          >
                            {count(value)}
                          </td>
                        ))}
                        {index === 0 && (
                          <td
                            rowSpan={groups.length}
                            className="px-3 py-3 align-top tabular-nums text-fg-2"
                          >
                            <p>
                              {serverDollars(
                                record.snapshot?.estimatedUsageUsdMicros,
                              )}
                            </p>
                            {record.snapshot?.nativeUsageUsdMicros !== null &&
                              record.snapshot?.nativeUsageUsdMicros !==
                                undefined && (
                                <p className="mt-0.5 text-fg-3">
                                  {tx(
                                    "nativeSeparate",
                                    "Native amount (separate)",
                                  )}
                                  :{" "}
                                  {serverDollars(
                                    record.snapshot.nativeUsageUsdMicros,
                                  )}
                                </p>
                              )}
                            {record.snapshot && (
                              <p className="mt-0.5 text-fg-3">
                                {tx("creditsMicros", "Reported credit micros")}:{" "}
                                {count(
                                  record.snapshot.estimatedUsageCreditsMicros,
                                )}
                              </p>
                            )}
                          </td>
                        )}
                        {index === 0 && (
                          <td
                            rowSpan={groups.length}
                            className="max-w-[250px] whitespace-normal px-3 py-3 align-top text-fg-3"
                          >
                            <p>{state(record)}</p>
                            <p className="mt-0.5">
                              {tx("checkedAt", "Checked at")}:{" "}
                              {formatAnalyticsTimestamp(
                                record.checkedAt,
                                locale,
                              ) ?? "—"}
                            </p>
                            {record.lastSuccessAt !== null && (
                              <p className="mt-0.5">
                                {tx("lastSuccessAt", "Snapshot obtained at")}:{" "}
                                {formatAnalyticsTimestamp(
                                  record.lastSuccessAt,
                                  locale,
                                )}
                              </p>
                            )}
                            {record.error && (
                              <p className="mt-1 break-words text-warning-text">
                                {record.error}
                              </p>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
