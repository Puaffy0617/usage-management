import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  buildUnifiedHeatmap,
  UnifiedUsageOverview,
} from "@/components/usage/UnifiedUsageOverview";
import { formatApiEquivalentCny } from "@/components/usage/unifiedUsageData";

describe("Native account usage heatmap", () => {
  it("advances the visible calendar across UTC midnight on refresh without remounting", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T23:59:59Z"));
    try {
      const props = {
        total: { cost: null, requests: null, tokens: 100, hitRate: null },
        daily: {
          "2026-11-05": {
            cost: null,
            requests: null,
            tokens: 100,
            hitRate: null,
          },
        },
        metric: "tokens" as const,
        onMetricChange: () => {},
        note: "UTC refresh",
      };
      const view = render(<UnifiedUsageOverview {...props} />);
      expect(
        view.container.querySelector('[data-date="2026-11-06"]'),
      ).toHaveAttribute("data-state", "future");
      vi.setSystemTime(new Date("2026-11-06T00:00:01Z"));
      view.rerender(
        <UnifiedUsageOverview
          {...props}
          total={{ ...props.total, tokens: 300 }}
          daily={{
            ...props.daily,
            "2026-11-06": {
              cost: null,
              requests: null,
              tokens: 200,
              hitRate: null,
            },
          }}
        />,
      );
      const current = view.container.querySelector('[data-date="2026-11-06"]');
      expect(current).toHaveAttribute("data-state", "reported");
      expect(current).toHaveAttribute(
        "title",
        "2026-11-06 · Measured tokens: 200",
      );
      expect(
        view.container.querySelector('[data-date="2026-11-07"]'),
      ).toHaveAttribute("data-state", "future");
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps positive sub-cent estimates distinct from an explicitly reported zero", () => {
    expect(formatApiEquivalentCny(0.0001, "zh-CN")).toBe("<¥0.01");
    expect(formatApiEquivalentCny(0, "zh-CN")).toBe("¥0.00");
    expect(formatApiEquivalentCny(null, "zh-CN")).toBe("—");
  });
  it("builds exactly 53 UTC weeks across calendar boundaries", () => {
    const span = buildUnifiedHeatmap(new Date("2026-11-05T12:00:00Z"));
    expect(span.weeks).toHaveLength(53);
    expect(span.weeks.every((week) => week.length === 7)).toBe(true);
    expect(span.start.getUTCDay()).toBe(1);
    expect(span.weeks[52][3].key).toBe("2026-11-05");
    expect(span.weeks[52][4].future).toBe(true);
  });
  it("keeps unreported dates distinct from explicitly reported zero and shows all four real metric cards", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
    try {
      const select = vi.fn();
      const view = render(
        <UnifiedUsageOverview
          total={{ cost: null, requests: null, tokens: 0, hitRate: null }}
          daily={{
            "2026-11-04": { cost: 0, requests: 0, tokens: 0, hitRate: null },
          }}
          metric="tokens"
          onMetricChange={select}
          note="Only returned records"
        />,
      );
      const zero = view.container.querySelector('[data-date="2026-11-04"]')!;
      const unknown = view.container.querySelector('[data-date="2026-11-03"]')!;
      expect(zero).toHaveAttribute("data-state", "reported");
      expect(zero).toHaveAttribute("title", "2026-11-04 · Measured tokens: 0");
      expect(unknown).toHaveAttribute("data-state", "unavailable");
      expect(unknown).toHaveAttribute(
        "title",
        "2026-11-03 · Measured tokens: Not reported",
      );
      expect(view.container.querySelectorAll("[data-date]")).toHaveLength(
        53 * 7,
      );
      expect(
        screen.getByRole("button", { name: "Measured tokens 0" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Requests —" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Estimated API equivalent —" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Cache hit rate —" }),
      ).toBeInTheDocument();
      fireEvent.mouseEnter(unknown);
      expect(screen.getByRole("tooltip")).toHaveTextContent("Not reported");
      fireEvent.click(screen.getByRole("button", { name: "Requests —" }));
      expect(select).toHaveBeenCalledWith("requests");
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not spread a summary token total into fabricated daily activity", () => {
    const view = render(
      <UnifiedUsageOverview
        total={{ cost: null, requests: null, tokens: 1234, hitRate: null }}
        daily={{}}
        metric="tokens"
        onMetricChange={() => {}}
        note="Retained summary"
      />,
    );
    expect(
      view.container.querySelector('[data-state="reported"]'),
    ).not.toBeInTheDocument();
    expect(
      view.container.querySelectorAll('[data-state="unavailable"]').length,
    ).toBeGreaterThan(300);
  });
});
