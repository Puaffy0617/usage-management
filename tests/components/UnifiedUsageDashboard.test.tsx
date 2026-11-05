import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnifiedUsageDashboard } from "@/components/usage/UnifiedUsageDashboard";
import { unifiedUsageApi } from "@/lib/api/unifiedUsage";
import type {
  AnalyticsAccount,
  AnalyticsDashboard,
  MetricAggregate,
} from "@/types/unifiedUsage";

vi.mock("@/lib/api/unifiedUsage", () => ({
  unifiedUsageApi: {
    listAccounts: vi.fn(),
    importExistingAccounts: vi.fn(),
    dashboard: vi.fn(),
    sync: vi.fn(),
    addAccount: vi.fn(),
    updateAccount: vi.fn(),
    disconnectAccount: vi.fn(),
    removeAccount: vi.fn(),
    startLogin: vi.fn(),
    finishLogin: vi.fn(),
    cancelLogin: vi.fn(),
    import: vi.fn(),
    export: vi.fn(),
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const makeAccount = (id: string): AnalyticsAccount => ({
  id,
  name: `Account ${id}`,
  identity: `${id}@example.test`,
  subscription: "Pro",
  connectionStatus: "connected",
  lastSyncAt: null,
  lastError: null,
  syncIntervalMinutes: 0,
  summary: null,
  quota: null,
  quotaUpdatedAt: null,
  createdAt: 1_800_000_000_000,
});
const metric = (accountId: string, value: number): MetricAggregate => ({
  accountId,
  value,
  source: "codex_app_server",
  scope: "codex_account_activity",
  metric: "tokens",
  unit: "tokens",
  provenance: "official",
});
let accounts: AnalyticsAccount[];
let dashboard: AnalyticsDashboard;

function show() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <UnifiedUsageDashboard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  accounts = [];
  dashboard = {
    accounts: [],
    totals: [],
    daily: [],
    breakdowns: [],
    recordCount: 0,
    syncHistory: [],
  };
  vi.mocked(unifiedUsageApi.listAccounts).mockImplementation(
    async () => accounts,
  );
  vi.mocked(unifiedUsageApi.dashboard).mockImplementation(
    async () => dashboard,
  );
  vi.mocked(unifiedUsageApi.sync).mockResolvedValue({
    accounts: [],
    errors: [],
  });
});

describe("Unified account analytics", () => {
  it("imports both existing account links without starting sign-in, syncing, or disconnecting original sessions", async () => {
    vi.mocked(unifiedUsageApi.importExistingAccounts).mockImplementation(
      async () => {
        accounts = [
          { ...makeAccount("A"), linkedAccountId: "original-A" },
          { ...makeAccount("B"), linkedAccountId: "original-B" },
        ];
        dashboard.accounts = accounts;
        return { imported: 2, skipped: 0, accounts };
      },
    );
    show();
    await screen.findByText("Bring your accounts into one view");
    fireEvent.click(
      screen.getByRole("button", { name: "Import existing ChatGPT accounts" }),
    );
    expect(
      await screen.findByText("Account links imported: 2 · Already linked: 0"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByText("Existing CC Switch account")).toHaveLength(2),
    );
    expect(
      screen.getByText("Account A", { selector: "div" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Account B", { selector: "div" }),
    ).toBeInTheDocument();
    expect(unifiedUsageApi.startLogin).not.toHaveBeenCalled();
    expect(unifiedUsageApi.disconnectAccount).not.toHaveBeenCalled();
    expect(unifiedUsageApi.removeAccount).not.toHaveBeenCalled();
    expect(unifiedUsageApi.sync).not.toHaveBeenCalled();
  });

  it("keeps linked account authorization upstream and offers analytics-only unlinking", async () => {
    accounts = [
      {
        ...makeAccount("A"),
        linkedAccountId: "original-A",
        connectionStatus: "reauth_required",
      },
      {
        ...makeAccount("B"),
        linkedAccountId: "original-B",
        connectionStatus: "disconnected",
      },
    ];
    dashboard.accounts = accounts;
    vi.mocked(unifiedUsageApi.disconnectAccount).mockResolvedValue();
    show();
    const rowA = (
      await screen.findByText("Account A", { selector: "div" })
    ).closest("tr")!;
    const rowB = screen
      .getByText("Account B", { selector: "div" })
      .closest("tr")!;
    expect(
      within(rowA).queryByRole("button", { name: /^(Connect|Reconnect)$/ }),
    ).not.toBeInTheDocument();
    expect(
      within(rowB).queryByRole("button", { name: /^(Connect|Reconnect)$/ }),
    ).not.toBeInTheDocument();
    expect(
      within(rowA).getByText(
        "Manage this sign-in in CC Switch's Accounts page, then refresh analytics.",
      ),
    ).toBeInTheDocument();
    expect(
      within(rowB).getByText(
        "Import existing ChatGPT accounts again to resume analytics for this account.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      within(rowA).getByRole("button", { name: "Unlink analytics" }),
    );
    await waitFor(() =>
      expect(unifiedUsageApi.disconnectAccount).toHaveBeenCalledWith("A"),
    );
    expect(unifiedUsageApi.startLogin).not.toHaveBeenCalled();
    expect(unifiedUsageApi.removeAccount).not.toHaveBeenCalled();
  });

  it("starts with an honest empty state and no invented token total", async () => {
    show();
    expect(
      await screen.findByText("Bring your accounts into one view"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Missing data means unavailable, not zero/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Combined reported activity"),
    ).not.toBeInTheDocument();
    expect(unifiedUsageApi.sync).not.toHaveBeenCalled();
  });

  it("allows restoring a full backup into an empty installation", async () => {
    show();
    await screen.findByText("Bring your accounts into one view");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    const dialog = screen.getByRole("dialog", { name: "Import" });
    expect(within(dialog).getByLabelText("File format")).toHaveValue("backup");
    expect(
      within(dialog).getByRole("button", { name: "Choose file and import" }),
    ).toBeEnabled();
    expect(within(dialog).queryByLabelText("Account")).not.toBeInTheDocument();
  });

  it("renders documented quota windows without treating them as token totals", async () => {
    accounts = [
      {
        ...makeAccount("A"),
        quota: {
          rateLimits: {
            primary: {
              usedPercent: 25,
              windowDurationMins: 300,
              resetsAt: 1_800_000_000,
            },
          },
          rateLimitsByLimitId: {},
        },
      },
    ];
    dashboard.accounts = accounts;
    show();
    expect(await screen.findByText("75% remaining")).toBeInTheDocument();
    expect(
      screen.getByText("No measurable usage returned"),
    ).toBeInTheDocument();
    expect(screen.queryByText("0 tokens")).not.toBeInTheDocument();
  });

  it("retains credits-only named limits and earned resets without inventing token usage", async () => {
    accounts = [
      {
        ...makeAccount("A"),
        quota: {
          rateLimitsByLimitId: {
            codex: {
              limitName: "Codex credits",
              credits: {
                balance: "125.50",
                hasCredits: true,
                unlimited: false,
              },
            },
          },
          rateLimitResetCredits: { availableCount: 2 },
        },
      },
    ];
    dashboard.accounts = accounts;
    show();
    expect(
      await screen.findByText("Credit balance: 125.50"),
    ).toBeInTheDocument();
    expect(screen.getByText("Codex credits")).toBeInTheDocument();
    expect(screen.getByText("Credits available")).toBeInTheDocument();
    expect(screen.getByText("Unlimited credits: No")).toBeInTheDocument();
    expect(screen.getByText("Available earned resets: 2")).toBeInTheDocument();
    expect(screen.queryByText("Quota not reported")).not.toBeInTheDocument();
    expect(
      screen.getByText("No measurable usage returned"),
    ).toBeInTheDocument();
  });

  it("shows available summary fields even when lifetime tokens are unavailable", async () => {
    accounts = [
      {
        ...makeAccount("A"),
        summary: {
          lifetimeTokens: null,
          peakDailyTokens: 500,
          currentStreakDays: 0,
          longestStreakDays: 3,
          longestRunningTurnSec: 120,
        },
      },
    ];
    dashboard.accounts = accounts;
    show();
    expect(
      await screen.findByText("Peak daily tokens: 500"),
    ).toBeInTheDocument();
    expect(screen.getByText("Current streak (days): 0")).toBeInTheDocument();
    expect(screen.getByText("Longest streak (days): 3")).toBeInTheDocument();
    expect(screen.getByText("Longest turn (seconds): 120")).toBeInTheDocument();
    expect(
      screen.getByText("This snapshot may be older than the last sync."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No measurable usage returned"),
    ).toBeInTheDocument();
  });

  it("combines compatible official data and excludes local messages and estimates", async () => {
    accounts = [makeAccount("A"), makeAccount("B")];
    dashboard.accounts = accounts;
    dashboard.totals = [
      metric("A", 100),
      metric("B", 200),
      { ...metric("A", 9000), provenance: "estimated" },
      {
        ...metric("A", 77),
        source: "chatgpt_data_export",
        scope: "chatgpt_export_activity",
        provenance: "local",
        metric: "user_messages",
        unit: "messages",
      },
    ];
    dashboard.recordCount = 4;
    show();
    const selector = await screen.findByLabelText("Metric and coverage");
    const official = within(selector)
      .getAllByRole("option")
      .find((option) => option.textContent?.includes("Officially reported"))!;
    fireEvent.change(selector, {
      target: { value: (official as HTMLOptionElement).value },
    });
    expect(screen.getByText("300")).toBeInTheDocument();
    expect(screen.queryByText("9,300")).not.toBeInTheDocument();
    expect(screen.queryByText("9,377")).not.toBeInTheDocument();
    expect(screen.getAllByText("Quota not reported")).toHaveLength(2);
    expect(
      screen.getAllByText(
        "Daily history has not been reported for this metric.",
      ),
    ).toHaveLength(1);
    expect(
      screen.getAllByText("This source has not reported this breakdown."),
    ).toHaveLength(3);
  });

  it("keeps an unavailable account distinct from zero usage", async () => {
    accounts = [
      makeAccount("A"),
      {
        ...makeAccount("B"),
        connectionStatus: "reauth_required",
        lastError: "Authorization expired",
      },
    ];
    dashboard.accounts = accounts;
    dashboard.totals = [metric("A", 100)];
    show();
    const row = (
      await screen.findByText("Account B", { selector: "div" })
    ).closest("tr")!;
    expect(within(row).getByText("—")).toBeInTheDocument();
    expect(within(row).getByText("Authorization expired")).toBeInTheDocument();
    expect(within(row).queryByText("0 tokens")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Account"), {
      target: { value: "A" },
    });
    await waitFor(() =>
      expect(unifiedUsageApi.dashboard).toHaveBeenLastCalledWith(
        expect.objectContaining({ accountIds: ["A"] }),
      ),
    );
  });

  it("does not display a rounded cross-account total outside the safe numeric range", async () => {
    accounts = [makeAccount("A"), makeAccount("B")];
    dashboard.accounts = accounts;
    dashboard.totals = [metric("A", Number.MAX_SAFE_INTEGER), metric("B", 1)];
    show();
    expect(
      await screen.findByText("Outside supported numeric range"),
    ).toBeInTheDocument();
    expect(screen.queryByText("9,007,199,254,740,992")).not.toBeInTheDocument();
  });

  it("shows a sync failure without discarding the other account history", async () => {
    accounts = [makeAccount("A"), makeAccount("B")];
    dashboard.accounts = accounts;
    dashboard.totals = [metric("A", 12), metric("B", 34)];
    vi.mocked(unifiedUsageApi.sync).mockResolvedValue({
      accounts,
      errors: ["Account B needs sign-in"],
    });
    show();
    await screen.findByText("46");
    fireEvent.click(screen.getAllByRole("button", { name: "Sync now" })[0]);
    expect(
      await screen.findByText("Account B needs sign-in"),
    ).toBeInTheDocument();
    expect(screen.getByText("46")).toBeInTheDocument();
    expect(unifiedUsageApi.sync).toHaveBeenCalledWith(undefined);
  });

  it("refreshes all connected accounts even while the dashboard is filtered to one account", async () => {
    accounts = [makeAccount("A"), makeAccount("B")];
    dashboard.accounts = accounts;
    dashboard.totals = [metric("A", 12), metric("B", 34)];
    show();
    await screen.findByText("46");
    fireEvent.change(screen.getByLabelText("Account"), {
      target: { value: "A" },
    });
    await waitFor(() =>
      expect(unifiedUsageApi.dashboard).toHaveBeenLastCalledWith(
        expect.objectContaining({ accountIds: ["A"] }),
      ),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Sync now" })[0]);
    await waitFor(() => expect(unifiedUsageApi.sync).toHaveBeenCalledTimes(1));
    expect(unifiedUsageApi.sync).toHaveBeenCalledWith(undefined);
    expect(unifiedUsageApi.sync).not.toHaveBeenCalledWith("A");
  });

  it("retries transient account errors at the configured interval and isolates failures from other accounts", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const now = Date.parse("2026-11-05T00:00:00Z");
    vi.setSystemTime(now);
    const enabled = { syncIntervalMinutes: 5, lastSyncAt: now - 5 * 60_000 };
    accounts = [
      { ...makeAccount("A"), ...enabled, connectionStatus: "error" },
      { ...makeAccount("B"), ...enabled },
      ...["reauth_required", "unsupported", "disconnected", "pending"].map(
        (status) => ({
          ...makeAccount(status),
          ...enabled,
          connectionStatus: status,
        }),
      ),
      {
        ...makeAccount("unidentified"),
        ...enabled,
        connectionStatus: "error",
        identity: null,
      },
    ];
    dashboard.accounts = accounts;
    vi.mocked(unifiedUsageApi.sync).mockImplementation(async (id) => {
      if (id === "A") throw new Error("Transient transport failure for A");
      return { accounts, errors: [] };
    });
    const view = show();
    try {
      await screen.findByText("Account A", { selector: "div" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      await waitFor(() =>
        expect(unifiedUsageApi.sync).toHaveBeenCalledTimes(2),
      );
      expect(
        vi.mocked(unifiedUsageApi.sync).mock.calls.map(([id]) => id),
      ).toEqual(["A", "B"]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4 * 60_000);
      });
      expect(unifiedUsageApi.sync).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      await waitFor(() =>
        expect(unifiedUsageApi.sync).toHaveBeenCalledTimes(4),
      );
      expect(
        vi.mocked(unifiedUsageApi.sync).mock.calls.map(([id]) => id),
      ).toEqual(["A", "B", "A", "B"]);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
});
