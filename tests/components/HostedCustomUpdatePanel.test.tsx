import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostedCustomUpdatePanel } from "@/components/settings/HostedCustomUpdatePanel";
import {
  customUpdateApi,
  type CustomReleaseStatus,
} from "@/lib/api/customUpdate";

const stock = vi.hoisted(() => ({
  install: vi.fn(),
  portable: vi.fn(),
  fallback: vi.fn(),
}));
vi.mock("@/lib/api/customUpdate", () => ({
  CUSTOM_RELEASE_STATUS_KEY: ["hosted-custom-update-status"],
  CUSTOM_RELEASE_CHECK_KEY: ["hosted-custom-update-check"],
  CUSTOM_RELEASE_CHECK_INTERVAL_MS: 6 * 60 * 60 * 1000,
  customUpdateApi: { status: vi.fn(), check: vi.fn(), install: vi.fn() },
}));
vi.mock("@/lib/api", () => ({
  settingsApi: {
    installUpdateAndRestart: stock.install,
    openPortableUpdateDownload: stock.portable,
    checkUpdates: stock.fallback,
  },
}));
const status = (configured = true): CustomReleaseStatus => ({
  configured,
  edition: "cc-switch-unified-usage",
  repository: configured ? "owner/usage-management" : null,
  channel: "stable",
  currentVersion: "4.0.25-usage.1",
  reason: configured ? null : "No pinned signed channel",
});
const available = {
  configured: true,
  available: true,
  currentVersion: "4.0.25-usage.1",
  release: {
    version: "4.0.25-usage.2",
    notes: "Custom analytics improvements",
    pubDate: "2026-11-06T00:00:00Z",
  },
  reason: null,
};
function show() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <HostedCustomUpdatePanel />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.mocked(customUpdateApi.status).mockResolvedValue(status());
  vi.mocked(customUpdateApi.check).mockResolvedValue(available);
  vi.mocked(customUpdateApi.install).mockResolvedValue(true);
});
function expectNoStockFallback() {
  expect(stock.install).not.toHaveBeenCalled();
  expect(stock.portable).not.toHaveBeenCalled();
  expect(stock.fallback).not.toHaveBeenCalled();
}

describe("Pinned signed custom release channel", () => {
  it("is honest and network-idle when the optional channel is not configured", async () => {
    vi.mocked(customUpdateApi.status).mockResolvedValue(status(false));
    show();
    expect(
      await screen.findByText(
        "No signed custom release channel is configured in this build.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Check custom releases" }),
    ).toBeDisabled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /install/i }),
    ).not.toBeInTheDocument();
    expect(customUpdateApi.check).not.toHaveBeenCalled();
    expect(customUpdateApi.install).not.toHaveBeenCalled();
    expectNoStockFallback();
  });
  it("requires an explicit check and installs only the exact returned custom version", async () => {
    show();
    await screen.findByText("Pinned repository: owner/usage-management");
    expect(customUpdateApi.check).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Check custom releases" }),
    );
    expect(
      await screen.findByText("Custom release available: 4.0.25-usage.2"),
    ).toBeInTheDocument();
    const install = screen.getByRole("button", {
      name: "Verify, install custom update, and restart",
    });
    fireEvent.click(install);
    fireEvent.click(install);
    await waitFor(() =>
      expect(customUpdateApi.install).toHaveBeenCalledTimes(1),
    );
    expect(customUpdateApi.install).toHaveBeenCalledWith("4.0.25-usage.2");
    expect(
      screen.getByText("Verifying and installing the custom update…"),
    ).toBeInTheDocument();
    expectNoStockFallback();
  });
  it("does not fall back to stock updates when checking the custom channel fails", async () => {
    vi.mocked(customUpdateApi.check).mockRejectedValue(
      new Error("Custom metadata unavailable"),
    );
    show();
    await screen.findByText("Pinned repository: owner/usage-management");
    fireEvent.click(
      screen.getByRole("button", { name: "Check custom releases" }),
    );
    expect(
      await screen.findByText("Error: Custom metadata unavailable"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /install/i }),
    ).not.toBeInTheDocument();
    expect(customUpdateApi.install).not.toHaveBeenCalled();
    expectNoStockFallback();
  });
  it("clears the checked release after signature or installation failure, requiring another check", async () => {
    vi.mocked(customUpdateApi.install).mockRejectedValue(
      new Error("Signature verification failed"),
    );
    show();
    await screen.findByText("Pinned repository: owner/usage-management");
    fireEvent.click(
      screen.getByRole("button", { name: "Check custom releases" }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Verify, install custom update, and restart",
      }),
    );
    expect(
      await screen.findByText("Error: Signature verification failed"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Verify, install custom update, and restart",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Check custom releases" }),
    ).toBeEnabled();
    expectNoStockFallback();
  });
  it("does not present installation when the native check returns no newer custom release", async () => {
    vi.mocked(customUpdateApi.check).mockResolvedValue({
      ...available,
      available: false,
      release: null,
    });
    show();
    await screen.findByText("Pinned repository: owner/usage-management");
    fireEvent.click(
      screen.getByRole("button", { name: "Check custom releases" }),
    );
    expect(
      await screen.findByText(
        "No newer custom release is available from the pinned channel.",
      ),
    ).toBeInTheDocument();
    expect(customUpdateApi.install).not.toHaveBeenCalled();
    expectNoStockFallback();
  });
  it("handles a stale release without selecting an alternate installer", async () => {
    vi.mocked(customUpdateApi.install).mockResolvedValue(false);
    show();
    await screen.findByText("Pinned repository: owner/usage-management");
    fireEvent.click(
      screen.getByRole("button", { name: "Check custom releases" }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Verify, install custom update, and restart",
      }),
    );
    expect(
      await screen.findByText(
        "No newer custom release remains available. Check the pinned channel again.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Verify, install custom update, and restart",
      }),
    ).not.toBeInTheDocument();
    expectNoStockFallback();
  });
});
