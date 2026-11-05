import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnifiedUpdatePanel } from "@/components/settings/UnifiedUpdatePanel";
import {
  unifiedUpdateApi,
  type UnifiedUpdateStatus,
} from "@/lib/api/unifiedUpdate";
import { open } from "@tauri-apps/plugin-dialog";

vi.mock("@/lib/api/unifiedUpdate", () => ({
  UNIFIED_UPDATE_CHANGED: "test-update-changed",
  unifiedUpdateApi: { status: vi.fn(), configure: vi.fn(), prepare: vi.fn() },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn() }));
const status = (
  phase: UnifiedUpdateStatus["phase"] = "idle",
): UnifiedUpdateStatus => ({
  edition: "cc-switch-unified-usage",
  upstreamVersion: "4.0.25",
  sourceDir: "C:/custom-source",
  autoPrepare: false,
  phase,
  targetVersion: "4.0.26",
  candidateDir: null,
  error: null,
});
function show() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <UnifiedUpdatePanel availableVersion="4.0.26" />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.mocked(unifiedUpdateApi.status).mockResolvedValue(status());
  vi.mocked(unifiedUpdateApi.prepare).mockResolvedValue(status("preparing"));
});

describe("Compatible custom update workflow", () => {
  it("prepares only a separate candidate through the native custom command", async () => {
    show();
    await screen.findByText("Ready to prepare a compatible update · 4.0.26");
    fireEvent.click(
      screen.getByRole("button", { name: "Prepare compatible custom update" }),
    );
    await waitFor(() =>
      expect(unifiedUpdateApi.prepare).toHaveBeenCalledWith("4.0.26"),
    );
    expect(
      await screen.findByText(/Merging upstream changes/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /install|restart/i }),
    ).not.toBeInTheDocument();
  });
  it("stops after source validation fails without preparing or invoking an installer", async () => {
    vi.mocked(unifiedUpdateApi.status).mockResolvedValue({
      ...status("not_configured"),
      sourceDir: null,
    });
    vi.mocked(open).mockResolvedValue("C:/wrong-source");
    vi.mocked(unifiedUpdateApi.configure).mockRejectedValue(
      new Error("Missing custom manifest"),
    );
    show();
    await screen.findByText(/Choose a source checkout/);
    fireEvent.click(
      screen.getByRole("button", { name: "Prepare compatible custom update" }),
    );
    expect(
      await screen.findByText(/Missing custom manifest/),
    ).toBeInTheDocument();
    expect(unifiedUpdateApi.prepare).not.toHaveBeenCalled();
  });
  it("persists explicit automatic preparation without directly launching another job", async () => {
    vi.mocked(unifiedUpdateApi.configure).mockResolvedValue({
      ...status(),
      autoPrepare: true,
    });
    show();
    await screen.findByText("Ready to prepare a compatible update · 4.0.26");
    fireEvent.click(
      screen.getByRole("switch", {
        name: "Prepare detected upstream updates automatically",
      }),
    );
    await waitFor(() =>
      expect(unifiedUpdateApi.configure).toHaveBeenCalledWith(
        "C:/custom-source",
        true,
      ),
    );
    expect(
      screen.getByRole("switch", {
        name: "Prepare detected upstream updates automatically",
      }),
    ).toBeChecked();
    expect(unifiedUpdateApi.prepare).not.toHaveBeenCalled();
  });
  it.each(["conflict", "migration_review"] as const)(
    "requires explicit review for %s without presenting installation",
    async (phase) => {
      vi.mocked(unifiedUpdateApi.status).mockResolvedValue({
        ...status(phase),
        candidateDir: "C:/candidate",
      });
      show();
      expect(
        await screen.findByText(
          "Review is required before this candidate can be used",
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("C:/candidate")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /install|restart/i }),
      ).not.toBeInTheDocument();
    },
  );
  it("polls only while preparing and stops when the compatible candidate is ready", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.mocked(unifiedUpdateApi.status)
      .mockResolvedValueOnce(status("preparing"))
      .mockResolvedValue({
        ...status("ready"),
        candidateDir: "C:/ready-candidate",
      });
    const view = show();
    try {
      await screen.findByText(/Merging upstream changes/);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await screen.findByText(/Compatible candidate built/);
      expect(unifiedUpdateApi.status).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(unifiedUpdateApi.status).toHaveBeenCalledTimes(2);
      expect(
        screen.getByText(/no hosted signed update channel/),
      ).toBeInTheDocument();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
});
