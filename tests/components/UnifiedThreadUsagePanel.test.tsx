import { act, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnifiedThreadUsagePanel } from "@/components/usage/UnifiedThreadUsagePanel";
import { unifiedUsageApi } from "@/lib/api/unifiedUsage";
import type {
  AnalyticsAccount,
  ThreadUsageDashboard,
  ThreadUsageRecord,
} from "@/types/unifiedUsage";

vi.mock("@/lib/api/unifiedUsage", () => ({
  unifiedUsageApi: { threadDashboard: vi.fn() },
}));
const pricing = vi.hoisted(() => ({
  usdToCny: 7 as number | null,
  fx: { status: "ready" },
}));
vi.mock("@/hooks/useUnifiedUsagePricing", () => ({
  useUnifiedUsagePricing: () => pricing,
}));
const account = (id: string) =>
  ({ id, name: `Account ${id}` }) as AnalyticsAccount;
const record = (
  accountId: string,
  threadId: string,
  usdMicros: number | null,
): ThreadUsageRecord => ({
  accountId,
  threadId,
  status: "available",
  checkedAt: 1_800_000_100_000,
  lastSuccessAt: 1_800_000_000_000,
  error: null,
  snapshot: {
    threadId,
    day: null,
    estimatedUsageCreditsMicros: 999_000_000,
    estimatedUsageUsdMicros: usdMicros,
    nativeUsageUsdMicros: null,
    groups: [
      {
        model: "reported-model",
        reasoningEffort: "high",
        speed: "fast",
        estimatedUsageCreditsMicros: 999_000_000,
        netNewInputTokens: 20,
        cachedInputTokens: 80,
        inputTokens: 100,
        outputTokens: 30,
        totalTokens: 130,
      },
    ],
  },
});
let data: ThreadUsageDashboard;
function show(accountId = "") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <UnifiedThreadUsagePanel
      accounts={[account("A"), account("B")]}
      accountId={accountId}
    />,
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  return { ...view, client };
}
beforeEach(() => {
  data = { records: [], candidateCount: 0 };
  pricing.usdToCny = 7;
  pricing.fx.status = "ready";
  vi.mocked(unifiedUsageApi.threadDashboard).mockImplementation(
    async () => data,
  );
});

describe("separate official thread lifetime snapshots", () => {
  it("explains an empty supported-source result without treating missing snapshots as zero usage", async () => {
    show();
    expect(
      await screen.findByText(
        /No supported thread snapshots have been returned yet/,
      ),
    ).toBeInTheDocument();
    expect(unifiedUsageApi.threadDashboard).toHaveBeenCalledWith();
    expect(
      screen.getByText(/do not enter the daily heatmap, main totals/),
    ).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("uses only reported server USD for the conversion and preserves actual model counters", async () => {
    const item = record("A", "official-thread", 4_500_000);
    item.snapshot!.nativeUsageUsdMicros = 100_000_000;
    data = { records: [item], candidateCount: 3 };
    show();
    const panel = await screen.findByRole("region", {
      name: "Discovered threads · Lifetime snapshots",
    });
    expect(await within(panel).findByText("¥31.50")).toBeInTheDocument();
    expect(
      within(panel).getByText("Native amount (separate): $100.00"),
    ).toBeInTheDocument();
    expect(within(panel).getByText("reported-model")).toBeInTheDocument();
    const row = within(panel).getByText("Account A").closest("tr")!;
    expect(within(row).getByText("20")).toBeInTheDocument();
    expect(within(row).getByText("80")).toBeInTheDocument();
    expect(within(row).getByText("130")).toBeInTheDocument();
    expect(
      within(panel).queryByText(/request count|requests per day/i),
    ).not.toBeInTheDocument();
  });

  it("leaves USD and CNY unavailable when only credit micros or a separate native amount are reported", async () => {
    const item = record("A", "credits-only", null);
    item.snapshot!.nativeUsageUsdMicros = 2_000_000;
    item.snapshot!.groups[0].netNewInputTokens = null;
    data = { records: [item], candidateCount: 1 };
    show();
    await screen.findByText("credits-only");
    const summary = screen.getByText("CNY conversion:").parentElement!;
    expect(within(summary).queryByText("¥14.00")).not.toBeInTheDocument();
    expect(
      screen.getByText("Native amount (separate): $2.00"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Reported credit micros: 999,000,000"),
    ).toBeInTheDocument();
    expect(screen.queryByText("¥0.00")).not.toBeInTheDocument();
  });

  it("detects shared-thread ambiguity before the account filter and excludes it only from the combined subtotal", async () => {
    data = {
      records: [
        record("A", "shared-thread", 1_000_000),
        record("B", "shared-thread", 1_000_000),
        record("A", "unique-thread", 2_000_000),
      ],
      candidateCount: 2,
    };
    const view = show();
    expect(await screen.findByText("¥14.00 *")).toBeInTheDocument();
    expect(
      screen.getByText(/excluded from the combined USD subtotal/),
    ).toBeInTheDocument();
    view.rerender(
      <UnifiedThreadUsagePanel
        accounts={[account("A"), account("B")]}
        accountId="A"
      />,
    );
    expect(await screen.findByText("¥21.00")).toBeInTheDocument();
    expect(
      screen.getByText(/snapshot is shown for accessibility only/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Account B")).not.toBeInTheDocument();
    expect(
      screen.getByText("Shared accessibility; owner unverified"),
    ).toBeInTheDocument();
    expect(unifiedUsageApi.threadDashboard).toHaveBeenCalledTimes(1);
  });

  it("marks retained snapshots stale after failed checks and keeps unavailable thread counters missing", async () => {
    const retained = record("A", "retained-thread", 2_000_000);
    retained.status = "error";
    retained.error = "Official thread read temporarily failed";
    const missing = {
      ...record("B", "unsupported-thread", null),
      snapshot: null,
      lastSuccessAt: null,
      status: "unavailable" as const,
    };
    data = { records: [retained, missing], candidateCount: 2 };
    pricing.fx.status = "stale";
    show();
    expect(
      await screen.findByText(
        "Retained snapshot; latest check did not succeed",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Official thread read temporarily failed"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No supported thread snapshot returned"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Previous exchange rate/)).toBeInTheDocument();
    expect(screen.getByText("¥14.00 *")).toBeInTheDocument();
    expect(screen.getAllByText(/Snapshot obtained at:/)).toHaveLength(1);
  });

  it("refreshes from the existing all-account query invalidation without a separate collector", async () => {
    data = {
      records: [record("A", "changing-thread", 1_000_000)],
      candidateCount: 1,
    };
    const view = show();
    expect(await screen.findByText("¥7.00")).toBeInTheDocument();
    data = {
      records: [record("A", "changing-thread", 2_000_000)],
      candidateCount: 1,
    };
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ["unified-usage"] });
    });
    expect(await screen.findByText("¥14.00")).toBeInTheDocument();
    expect(unifiedUsageApi.threadDashboard).toHaveBeenCalledTimes(2);
  });

  it("retains a reported USD estimate when no real exchange rate is available", async () => {
    pricing.usdToCny = null;
    data = {
      records: [record("A", "no-fx-thread", 1_000_000)],
      candidateCount: 1,
    };
    show();
    await screen.findByText("no-fx-thread");
    expect(screen.getAllByText("$1.00")).toHaveLength(2);
    expect(screen.getByText("CNY conversion:")).toHaveTextContent("—");
    expect(screen.queryByText(/¥/)).not.toBeInTheDocument();
  });

  it("distinguishes a positive sub-cent official estimate from an explicitly reported zero", async () => {
    data = {
      records: [record("A", "tiny-thread", 1), record("B", "zero-thread", 0)],
      candidateCount: 2,
    };
    show();
    expect(await screen.findByText("<¥0.01")).toBeInTheDocument();
    expect(screen.getAllByText("<$0.01")).toHaveLength(2);
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });
});
