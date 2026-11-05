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
import { settingsApi } from "@/lib/api/settings";
import type { ModelPricing } from "@/types/usage";
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
const pricingState = vi.hoisted(() => ({
  pricing: [] as ModelPricing[],
  usdToCny: 7,
  fx: {
    status: "ready",
    source: "Test exchange feed",
    updatedAt: 1,
    providerName: null as string | null,
    providerUrl: null as string | null,
  },
  isLoading: false,
  error: null,
  refresh: vi.fn(async () => {}),
}));
vi.mock("@/hooks/useUnifiedUsagePricing", () => ({
  useUnifiedUsagePricing: () => pricingState,
}));

const makeAccount = (id: string): AnalyticsAccount => ({
  id,
  name: `Account ${id}`,
  identity: `${id}@example.test`,
  subscription: "Pro",
  connectionStatus: "connected",
  lastSyncAt: Date.now(),
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

async function openManagement() {
  fireEvent.click(screen.getByRole("button", { name: "Manage accounts" }));
  return screen.findByRole("dialog", { name: "Manage accounts" });
}
beforeEach(() => {
  localStorage.removeItem("cc-switch.unified-usage.autoRefresh");
  localStorage.removeItem("cc-switch.unified-usage.autoRefreshMs");
  delete document.documentElement.dataset.windowActive;
  pricingState.pricing = [];
  Object.assign(pricingState.fx, {
    status: "ready",
    source: "Test exchange feed",
    updatedAt: 1,
    providerName: null,
    providerUrl: null,
  });
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
  vi.mocked(unifiedUsageApi.dashboard).mockImplementation(async () => {
    const grouped = new Map<
      string,
      NonNullable<AnalyticsDashboard["usageBuckets"]>[number]
    >();
    for (const row of dashboard.daily.length
      ? dashboard.daily
      : dashboard.totals.map((item) => ({ ...item, date: "2026-11-05" }))) {
      const key = JSON.stringify([
        row.accountId,
        row.source,
        row.scope,
        row.provenance,
        row.date,
      ]);
      const bucket = grouped.get(key) ?? {
        accountId: row.accountId,
        source: row.source,
        scope: row.scope,
        provenance: row.provenance,
        day: row.date,
        granularity: "day" as const,
        model: null,
        platform: null,
        feature: null,
        metrics: [],
      };
      bucket.metrics.push({
        metric: row.metric,
        unit: row.unit,
        value: row.value,
      });
      grouped.set(key, bucket);
    }
    return {
      ...dashboard,
      usageBuckets: dashboard.usageBuckets ?? [...grouped.values()],
    };
  });
  vi.mocked(unifiedUsageApi.sync).mockResolvedValue({
    accounts: [],
    errors: [],
  });
});

describe("Unified account analytics", () => {
  it("prefers official provenance over an unknown family while preserving an explicit family choice", async () => {
    accounts = [makeAccount("A")];
    dashboard.accounts = accounts;
    const bucket = {
      accountId: "A",
      source: "codex_app_server",
      scope: "codex_account_activity",
      provenance: "official",
      granularity: "day" as const,
      day: "2026-11-05",
      model: null,
      platform: null,
      feature: null,
      metrics: [{ metric: "tokens", unit: "tokens", value: 10 }],
    };
    dashboard.usageBuckets = [
      {
        ...bucket,
        source: "unknown-service",
        provenance: "unverified",
        metrics: [{ metric: "tokens", unit: "tokens", value: 9000 }],
      },
      bucket,
    ];
    show();
    expect(
      await screen.findByRole("button", { name: "Measured tokens 10" }),
    ).toBeInTheDocument();
    const selector = screen.getByLabelText(
      "Data source and coverage",
    ) as HTMLSelectElement;
    expect(selector.selectedOptions[0]).toHaveTextContent(
      "Officially reported",
    );
    expect(selector.selectedOptions[0].textContent).toMatch(/Daily$/);
    const unknown = within(selector)
      .getAllByRole("option")
      .find((option) =>
        option.textContent?.includes("unknown-service"),
      ) as HTMLOptionElement;
    fireEvent.change(selector, { target: { value: unknown.value } });
    expect(
      await screen.findByRole("button", { name: "Measured tokens 9,000" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() =>
      expect(unifiedUsageApi.sync).toHaveBeenCalledWith(undefined),
    );
    expect(selector).toHaveValue(unknown.value);
  });

  it("shows both reported lifetime snapshots secondarily without turning them into date-filtered totals, cost, or daily history", async () => {
    accounts = [
      { ...makeAccount("A"), summary: { lifetimeTokens: 1000000 } },
      { ...makeAccount("B"), summary: { lifetimeTokens: 2000000 } },
    ];
    dashboard.accounts = accounts;
    dashboard.usageBuckets = [];
    const view = show();
    const first = await screen.findByText("Lifetime snapshot: 1M Tokens");
    expect(first).toHaveAttribute(
      "title",
      expect.stringContaining("Excluded from the current date/model estimate"),
    );
    expect(
      screen.getByText("Lifetime snapshot: 2M Tokens"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Manage accounts" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Measured tokens —" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Estimated API equivalent —" }),
    ).toBeInTheDocument();
    expect(
      view.container.querySelector('[data-state="reported"]'),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Daily records/ }));
    expect(
      screen.getByText("No records have been returned for this selection."),
    ).toBeInTheDocument();
  });
  it("shows linked FX attribution and fetch time beside estimates without opening account management", async () => {
    Object.assign(pricingState.fx, {
      status: "stale",
      source: "open.er-api.com",
      providerName: "ExchangeRate-API",
      providerUrl: "https://www.exchangerate-api.com/",
      updatedAt: Date.parse("2026-11-05T00:00:00Z"),
    });
    const external = vi.spyOn(settingsApi, "openExternal").mockResolvedValue();
    try {
      show();
      const provider = await screen.findByRole("button", {
        name: "ExchangeRate-API",
      });
      expect(
        screen.queryByRole("dialog", { name: "Manage accounts" }),
      ).not.toBeInTheDocument();
      expect(screen.getByText(/1 USD = 7 CNY/)).toBeInTheDocument();
      expect(screen.getByText(/Fetched at:/)).toBeInTheDocument();
      expect(screen.getByText("Previous rate")).toBeInTheDocument();
      fireEvent.click(provider);
      expect(external).toHaveBeenCalledWith(
        "https://www.exchangerate-api.com/",
      );
    } finally {
      external.mockRestore();
    }
  });
  it("renders model-priced API equivalents from real bucket counters and keeps an unreported second account visible", async () => {
    pricingState.pricing = [
      {
        modelId: "test-model",
        displayName: "Test model",
        inputCostPerMillion: "2",
        outputCostPerMillion: "4",
        cacheReadCostPerMillion: "0.5",
        cacheCreationCostPerMillion: "0",
      },
    ];
    accounts = [makeAccount("A"), makeAccount("B")];
    dashboard.accounts = accounts;
    dashboard.usageBuckets = [
      {
        accountId: "A",
        source: "imported_usage",
        scope: "imported:known",
        provenance: "local",
        granularity: "day",
        day: "2026-11-05",
        model: "test-model",
        platform: null,
        feature: null,
        metrics: [
          { metric: "input_tokens_total", unit: "tokens", value: 1000 },
          { metric: "output_tokens", unit: "tokens", value: 100 },
          { metric: "cache_read_tokens", unit: "tokens", value: 200 },
          { metric: "cache_creation_tokens", unit: "tokens", value: 0 },
          { metric: "requests", unit: "requests", value: 3 },
        ],
      },
    ];
    show();
    expect(
      await screen.findByRole("button", { name: "Measured tokens 1,100" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Requests 3" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cache hit rate 20%" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Estimated API equivalent.*0\.01/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/not a ChatGPT subscription charge/),
    ).toBeInTheDocument();
    const accountB = screen
      .getByText("Account B", { selector: "button" })
      .closest("tr")!;
    expect(within(accountB).getAllByText("—").length).toBeGreaterThan(2);
    fireEvent.click(screen.getByRole("tab", { name: /Daily records/ }));
    expect(
      screen.getByRole("cell", { name: "2026-11-05" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("cell", { name: "Daily aggregate" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/not individual request logs/)).toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", {
        name: /latency|first token|speed/i,
      }),
    ).not.toBeInTheDocument();
  });

  it("renames an account through secondary management without changing its existing sign-in", async () => {
    accounts = [makeAccount("A")];
    dashboard.accounts = accounts;
    vi.mocked(unifiedUsageApi.updateAccount).mockResolvedValue({
      ...accounts[0],
      name: "Renamed",
    });
    show();
    const management = await openManagement();
    fireEvent.click(
      await within(management).findByRole("button", { name: "Edit" }),
    );
    const edit = screen.getByRole("dialog", { name: "Edit account" });
    fireEvent.change(within(edit).getByLabelText("Account name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(within(edit).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(unifiedUsageApi.updateAccount).toHaveBeenCalledWith(
        "A",
        "Renamed",
        0,
      ),
    );
    expect(unifiedUsageApi.startLogin).not.toHaveBeenCalled();
    expect(unifiedUsageApi.disconnectAccount).not.toHaveBeenCalled();
  });

  it("automatically refreshes both accounts by default, independently of account filters, only while visible and focused", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const now = Date.parse("2026-11-05T12:00:00Z");
    vi.setSystemTime(now);
    document.documentElement.dataset.windowActive = "false";
    accounts = [
      { ...makeAccount("A"), lastSyncAt: now - 600000 },
      { ...makeAccount("B"), lastSyncAt: now - 600000 },
    ];
    dashboard.accounts = accounts;
    const view = show();
    try {
      await screen.findByText("Account A", { selector: "button" });
      fireEvent.change(screen.getByLabelText("Account"), {
        target: { value: "A" },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120000);
      });
      expect(unifiedUsageApi.sync).not.toHaveBeenCalled();
      document.documentElement.dataset.windowActive = "true";
      fireEvent.focus(window);
      await waitFor(() =>
        expect(unifiedUsageApi.sync).toHaveBeenCalledTimes(2),
      );
      expect(
        vi.mocked(unifiedUsageApi.sync).mock.calls.map(([id]) => id),
      ).toEqual(["A", "B"]);
      document.documentElement.dataset.windowActive = "false";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(240000);
      });
      expect(unifiedUsageApi.sync).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      delete document.documentElement.dataset.windowActive;
      vi.useRealTimers();
    }
  });
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
      screen.getByText("Account A", { selector: "button" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Account B", { selector: "button" }),
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
    const management = await openManagement();
    const rowA = (
      await within(management).findByText("Account A", { selector: "div" })
    ).closest("tr")!;
    const rowB = within(management)
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
      screen.getByText(/Different sources and coverage scopes remain separate/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Combined reported activity"),
    ).not.toBeInTheDocument();
    expect(unifiedUsageApi.sync).not.toHaveBeenCalled();
  });

  it("allows restoring a full backup into an empty installation", async () => {
    show();
    await screen.findByText("Bring your accounts into one view");
    await openManagement();
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
    await openManagement();
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
    await openManagement();
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
    await openManagement();
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
    const selector = await screen.findByLabelText("Data source and coverage");
    const official = within(selector)
      .getAllByRole("option")
      .find((option) => option.textContent?.includes("Officially reported"))!;
    fireEvent.change(selector, {
      target: { value: (official as HTMLOptionElement).value },
    });
    expect(screen.getByText("300")).toBeInTheDocument();
    expect(screen.queryByText("9,300")).not.toBeInTheDocument();
    expect(screen.queryByText("9,377")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Requests —" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Estimated API equivalent —" }),
    ).toBeInTheDocument();
    await openManagement();
    expect(screen.getAllByText("Quota not reported")).toHaveLength(2);
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
      await screen.findByText("Account B", { selector: "button" })
    ).closest("tr")!;
    expect(within(row).getAllByText("—").length).toBeGreaterThan(0);
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
    await screen.findByRole("button", { name: "Measured tokens —" });
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
      await screen.findByText("Account A", { selector: "button" });
      await waitFor(() =>
        expect(unifiedUsageApi.sync).toHaveBeenCalledTimes(2),
      );
      expect(
        vi.mocked(unifiedUsageApi.sync).mock.calls.map(([id]) => id),
      ).toEqual(["A", "B"]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
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
