import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { formatTokensCompact } from "./format";
import { formatApiEquivalentCny } from "./unifiedUsageData";

export type UnifiedOverviewMetric = "cost" | "requests" | "tokens" | "hitRate";
export interface UnifiedOverviewValues {
  cost: number | null;
  requests: number | null;
  tokens: number | null;
  hitRate: number | null;
}
interface Props {
  total: UnifiedOverviewValues;
  daily: Record<string, UnifiedOverviewValues>;
  metric: UnifiedOverviewMetric;
  onMetricChange: (metric: UnifiedOverviewMetric) => void;
  note: string;
  partial?: Partial<Record<UnifiedOverviewMetric, boolean>>;
  attribution?: ReactNode;
}

/** UTC calendar cells keep an unreported day distinct from an observed zero. */
export function buildUnifiedHeatmap(today = new Date()) {
  const end = new Date(`${today.toISOString().slice(0, 10)}T00:00:00Z`);
  const monday = new Date(end);
  monday.setUTCDate(
    monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 52 * 7,
  );
  const weeks = Array.from({ length: 53 }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => {
      const date = new Date(monday);
      date.setUTCDate(date.getUTCDate() + week * 7 + day);
      return { date, key: date.toISOString().slice(0, 10), future: date > end };
    }),
  );
  return { start: monday, end, weeks };
}

export function UnifiedUsageOverview({
  total,
  daily,
  metric,
  onMetricChange,
  note,
  partial,
  attribution,
}: Props) {
  const { t, i18n } = useTranslation();
  const tx = (key: string, defaultValue: string) =>
    t(`unifiedUsage.${key}`, { defaultValue });
  const locale = i18n.language || "en";
  const section = useRef<HTMLElement>(null);
  const [hover, setHover] = useState<{
    key: string;
    x: number;
    y: number;
  } | null>(null);
  const utcDay = new Date().toISOString().slice(0, 10);
  const span = useMemo(
    () => buildUnifiedHeatmap(new Date(`${utcDay}T00:00:00Z`)),
    [utcDay],
  );
  const format = (kind: UnifiedOverviewMetric, value: number | null) => {
    if (
      value === null ||
      !Number.isFinite(value) ||
      Math.abs(value) > Number.MAX_SAFE_INTEGER
    )
      return "—";
    if (kind === "cost") return formatApiEquivalentCny(value, locale);
    if (kind === "hitRate")
      return new Intl.NumberFormat(locale, {
        style: "percent",
        maximumFractionDigits: 1,
      }).format(value);
    return formatTokensCompact(value, locale);
  };
  const titles: Record<UnifiedOverviewMetric, string> = {
    cost: tx("apiEquivalent", "Estimated API equivalent"),
    requests: tx("totalRequests", "Requests"),
    tokens: tx("measuredTokens", "Measured tokens"),
    hitRate: tx("cacheHitRate", "Cache hit rate"),
  };
  const reported = Object.values(daily)
    .map((day) => day[metric])
    .filter(
      (value): value is number =>
        value !== null && Number.isFinite(value) && value > 0,
    )
    .sort((a, b) => a - b);
  const threshold = [0.25, 0.5, 0.75].map(
    (fraction) =>
      reported[
        Math.min(reported.length - 1, Math.floor(reported.length * fraction))
      ] ?? Infinity,
  );
  const level = (value: number | null) =>
    value === null || value <= 0
      ? 0
      : value <= threshold[0]
        ? 1
        : value <= threshold[1]
          ? 2
          : value <= threshold[2]
            ? 3
            : 4;
  const weekday = Array.from({ length: 7 }, (_, day) =>
    new Date(Date.UTC(2026, 10, 2 + day)).toLocaleDateString(locale, {
      weekday: "short",
      timeZone: "UTC",
    }),
  );
  return (
    <section
      ref={section}
      className="relative shrink-0 overflow-hidden rounded-panel border border-border bg-surface"
    >
      <div className="grid grid-cols-2 border-b border-border md:grid-cols-4">
        {(["cost", "requests", "tokens", "hitRate"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            aria-pressed={metric === kind}
            onClick={() => onMetricChange(kind)}
            className={cn(
              "min-w-0 px-4 py-3 text-start transition-colors hover:bg-sidebar focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              metric === kind && "shadow-[inset_0_-2px_0_var(--text-1)]",
            )}
          >
            <span
              className={cn(
                "block text-caption",
                metric === kind ? "text-fg-1" : "text-fg-2",
              )}
            >
              {titles[kind]}
            </span>
            <span
              className={cn(
                "mt-1 block truncate text-[25px] font-semibold leading-8 tabular-nums",
                metric === kind ? "text-fg-1" : "text-fg-2",
              )}
            >
              {format(kind, total[kind])}
              {partial?.[kind] && total[kind] !== null ? " *" : ""}
            </span>
          </button>
        ))}
      </div>
      <div className="px-4 pb-3 pt-4">
        <h2 className="text-body font-semibold text-fg-1">
          {tx("heatmap", "Usage heatmap")}
        </h2>
        <p className="mt-0.5 text-caption text-fg-3">
          {tx(
            "heatmapDescription",
            "Daily activity over the latest 53 weeks · UTC. Unreported days are unavailable, not zero.",
          )}
        </p>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-2">
          <span className="text-body font-semibold tabular-nums text-fg-1">
            {span.start.toLocaleDateString(locale, { timeZone: "UTC" })} –{" "}
            {span.end.toLocaleDateString(locale, { timeZone: "UTC" })}
          </span>
          <span className="text-caption tabular-nums text-fg-3">
            {titles[metric]} · UTC
          </span>
        </div>
        <div
          className="mt-2 grid items-center gap-[3px]"
          style={{
            gridTemplateColumns: "max-content repeat(53, minmax(0, 1fr))",
          }}
          aria-label={tx("heatmap", "Usage heatmap")}
        >
          <span />
          {span.weeks.map((week, index) => (
            <span
              key={`month-${index}`}
              className="h-4 overflow-visible whitespace-nowrap text-badge leading-4 text-fg-3"
            >
              {index === 0 || week.some((cell) => cell.date.getUTCDate() === 1)
                ? (index === 0
                    ? week[0].date
                    : week.find((cell) => cell.date.getUTCDate() === 1)!.date
                  ).toLocaleDateString(locale, {
                    month: "short",
                    timeZone: "UTC",
                  })
                : ""}
            </span>
          ))}
          {weekday.map((label, day) => (
            <Fragment key={day}>
              <span className="pe-1.5 text-badge leading-none text-fg-3">
                {day % 2 === 0 ? label : ""}
              </span>
              {span.weeks.map((week) => {
                const cell = week[day];
                const value = daily[cell.key]?.[metric] ?? null;
                const intensity = level(value);
                return (
                  <div
                    key={cell.key}
                    data-date={cell.key}
                    data-state={
                      cell.future
                        ? "future"
                        : value === null
                          ? "unavailable"
                          : "reported"
                    }
                    title={
                      cell.future
                        ? undefined
                        : `${cell.key} · ${titles[metric]}: ${value === null ? tx("notReported", "Not reported") : format(metric, value)}`
                    }
                    className={cn(
                      "aspect-square w-full rounded-[3px]",
                      !cell.future && intensity === 0 && "bg-subtle",
                      !cell.future && value === null && "opacity-60",
                    )}
                    style={
                      cell.future || intensity === 0
                        ? undefined
                        : { backgroundColor: `var(--heat-${intensity})` }
                    }
                    onMouseEnter={
                      cell.future
                        ? undefined
                        : (event) => {
                            const box =
                              section.current?.getBoundingClientRect();
                            const rect =
                              event.currentTarget.getBoundingClientRect();
                            if (box)
                              setHover({
                                key: cell.key,
                                x: rect.left + rect.width / 2 - box.left,
                                y: rect.top - box.top,
                              });
                          }
                    }
                    onMouseLeave={() => setHover(null)}
                  />
                );
              })}
            </Fragment>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-end gap-1.5 text-badge text-fg-3">
          <span>{tx("unavailable", "Unavailable")}</span>
          <span className="h-2.5 w-2.5 rounded-[2px] bg-subtle opacity-60" />
          <span className="ms-2">{tx("less", "Less")}</span>
          {[0, 1, 2, 3, 4].map((item) => (
            <span
              key={item}
              className={cn(
                "h-2.5 w-2.5 rounded-[2px]",
                item === 0 && "bg-subtle",
              )}
              style={
                item === 0
                  ? undefined
                  : { backgroundColor: `var(--heat-${item})` }
              }
            />
          ))}
          <span>{tx("more", "More")}</span>
        </div>
        <p className="mt-3 text-caption text-fg-3">{note}</p>
        {attribution}
      </div>
      {hover && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-20 min-w-[180px] rounded-control border border-border bg-popover px-3 py-2 text-caption text-fg-2 shadow-v7-md"
          style={{
            left: hover.x,
            top: hover.y - 8,
            transform: `translate(${hover.x < 100 ? "-10%" : hover.x > (section.current?.clientWidth ?? 0) - 100 ? "-90%" : "-50%"}, -100%)`,
          }}
        >
          <p className="mb-1 font-medium text-fg-1">{hover.key} · UTC</p>
          {(["cost", "requests", "tokens", "hitRate"] as const).map((kind) => (
            <p key={kind} className="flex justify-between gap-3">
              <span>{titles[kind]}</span>
              <span className="tabular-nums">
                {daily[hover.key]?.[kind] === null ||
                daily[hover.key]?.[kind] === undefined
                  ? tx("notReported", "Not reported")
                  : format(kind, daily[hover.key][kind])}
              </span>
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
