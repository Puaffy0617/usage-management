import { act, render, screen, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostedCustomUpdateNotice } from "@/components/HostedCustomUpdateNotice";
import { HostedCustomUpdatePanel } from "@/components/settings/HostedCustomUpdatePanel";
import {
  customUpdateApi,
  CUSTOM_RELEASE_CHECK_INTERVAL_MS,
  CUSTOM_RELEASE_STATUS_KEY,
} from "@/lib/api/customUpdate";
import { toast } from "@/lib/toast";

vi.mock("@/lib/api/customUpdate", () => ({
  CUSTOM_RELEASE_STATUS_KEY: ["hosted-custom-update-status"],
  CUSTOM_RELEASE_CHECK_KEY: ["hosted-custom-update-check"],
  CUSTOM_RELEASE_CHECK_INTERVAL_MS: 6 * 60 * 60 * 1000,
  customUpdateApi: { status: vi.fn(), check: vi.fn(), install: vi.fn() },
}));
vi.mock("@/lib/toast", () => ({ toast: { info: vi.fn() } }));
const status = {
  configured: true,
  edition: "cc-switch-unified-usage" as const,
  repository: "owner/usage-management",
  channel: "stable" as const,
  currentVersion: "4.0.25-usage.1",
  reason: null,
};
const available = {
  configured: true,
  available: true,
  currentVersion: status.currentVersion,
  release: { version: "4.0.25-usage.2", notes: null, pubDate: null },
  reason: null,
};
function show(panel = false, preloadStatus = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (preloadStatus) client.setQueryData(CUSTOM_RELEASE_STATUS_KEY, status);
  const content = (showPanel: boolean) => (
    <QueryClientProvider client={client}>
      <HostedCustomUpdateNotice />
      <p>Application remains usable</p>
      {showPanel && <HostedCustomUpdatePanel />}
    </QueryClientProvider>
  );
  const view = render(content(panel));
  return { ...view, showPanel: () => view.rerender(content(true)) };
}
beforeEach(() => {
  vi.mocked(customUpdateApi.status).mockResolvedValue(status);
  vi.mocked(customUpdateApi.check).mockResolvedValue(available);
  for (const version of ["4.0.25-usage.2", "4.0.25-usage.3"])
    localStorage.removeItem(
      `cc-switch:custom-release-notice:${status.currentVersion}:${version}`,
    );
});

describe("Automatic custom release detection", () => {
  it("does not issue hosted check commands when the pinned channel is disabled", async () => {
    vi.mocked(customUpdateApi.status).mockResolvedValue({
      ...status,
      configured: false,
      repository: null,
    });
    show();
    expect(screen.getByText("Application remains usable")).toBeInTheDocument();
    await waitFor(() =>
      expect(customUpdateApi.status).toHaveBeenCalledTimes(1),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(customUpdateApi.check).not.toHaveBeenCalled();
    expect(customUpdateApi.install).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });
  it("announces an available custom release and reuses its startup cache in About", async () => {
    const view = show();
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "New custom release 4.0.25-usage.2 is available. Open Settings → About to review and install.",
        expect.any(Object),
      ),
    );
    view.showPanel();
    expect(
      await screen.findByText("Custom release available: 4.0.25-usage.2"),
    ).toBeInTheDocument();
    expect(customUpdateApi.check).toHaveBeenCalledTimes(1);
    expect(customUpdateApi.status).toHaveBeenCalledTimes(1);
    expect(customUpdateApi.install).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledTimes(1);
  });
  it("does not block the app or start another updater when the startup check fails", async () => {
    vi.mocked(customUpdateApi.check).mockRejectedValue(
      new Error("Hosted release check offline"),
    );
    show();
    expect(screen.getByText("Application remains usable")).toBeInTheDocument();
    await waitFor(() => expect(customUpdateApi.check).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(customUpdateApi.install).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });
  it("checks at most every six hours and skips intervals while the app is hidden", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    focusManager.setFocused(true);
    const view = show(false, true);
    try {
      await waitFor(() =>
        expect(customUpdateApi.check).toHaveBeenCalledTimes(1),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          CUSTOM_RELEASE_CHECK_INTERVAL_MS - 60_000,
        );
      });
      expect(customUpdateApi.check).toHaveBeenCalledTimes(1);
      focusManager.setFocused(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(customUpdateApi.check).toHaveBeenCalledTimes(1);
      focusManager.setFocused(true);
      vi.mocked(customUpdateApi.check).mockResolvedValue({
        ...available,
        release: { ...available.release, version: "4.0.25-usage.3" },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CUSTOM_RELEASE_CHECK_INTERVAL_MS);
      });
      await waitFor(() =>
        expect(customUpdateApi.check).toHaveBeenCalledTimes(2),
      );
      expect(customUpdateApi.install).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    }
  });
});
