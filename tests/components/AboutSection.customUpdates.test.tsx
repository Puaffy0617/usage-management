import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AboutSection } from "@/components/settings/AboutSection";

const state = vi.hoisted(() => ({
  check: vi.fn(),
  install: vi.fn(),
  portable: vi.fn(),
  fallback: vi.fn(),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "4.0.25"),
}));
vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => ({
    hasUpdate: true,
    updateInfo: {
      availableVersion: "4.0.26",
      distribution: "upstream",
      canInstall: false,
    },
    checkUpdate: state.check,
    isChecking: false,
  }),
}));
vi.mock("@/lib/api", () => ({
  settingsApi: {
    installUpdateAndRestart: state.install,
    openPortableUpdateDownload: state.portable,
    checkUpdates: state.fallback,
    openExternal: vi.fn(),
  },
}));
vi.mock("@/components/settings/UnifiedUpdatePanel", () => ({
  UnifiedUpdatePanel: () => <p>Compatible custom update controls</p>,
}));
vi.mock("@/components/settings/HostedCustomUpdatePanel", () => ({
  HostedCustomUpdatePanel: () => <p>Optional signed custom releases</p>,
}));
vi.mock("@/components/WhatsNewDialog", () => ({ WhatsNewDialog: () => null }));

describe("Custom About update policy", () => {
  beforeEach(() => {
    state.check.mockResolvedValue(true);
  });
  it.each([false, true])(
    "never offers a stock installation for portable=%s",
    async (isPortable) => {
      render(<AboutSection isPortable={isPortable} />);
      expect(
        await screen.findByText(/Upstream v4.0.26 is available/),
      ).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", { name: "Check upstream updates" }),
      );
      await waitFor(() => expect(state.check).toHaveBeenCalledTimes(1));
      expect(state.install).not.toHaveBeenCalled();
      expect(state.portable).not.toHaveBeenCalled();
      expect(state.fallback).not.toHaveBeenCalled();
    },
  );
  it("keeps check failures away from the stock fallback updater", async () => {
    state.check.mockRejectedValue(new Error("Offline"));
    render(<AboutSection isPortable={false} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Check upstream updates" }),
    );
    await waitFor(() => expect(state.check).toHaveBeenCalledTimes(1));
    expect(state.install).not.toHaveBeenCalled();
    expect(state.portable).not.toHaveBeenCalled();
    expect(state.fallback).not.toHaveBeenCalled();
  });
});
