import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UpdateProvider, useUpdate } from "@/contexts/UpdateContext";
import { checkForUpdate } from "@/lib/updater";
import { unifiedUpdateApi } from "@/lib/api/unifiedUpdate";

vi.mock("@/lib/updater", () => ({ checkForUpdate: vi.fn() }));
vi.mock("@/lib/api/unifiedUpdate", () => ({
  UNIFIED_UPDATE_CHANGED: "test-update-event",
  unifiedUpdateApi: { onUpstreamAvailable: vi.fn() },
}));
const available = {
  status: "available" as const,
  info: {
    currentVersion: "4.0.25",
    availableVersion: "4.0.26",
    distribution: "upstream" as const,
    canInstall: false as const,
  },
};

describe("Upstream compatibility advisory", () => {
  it("reports a detected release once to the native auto-prepare policy", async () => {
    vi.mocked(checkForUpdate).mockResolvedValue(available);
    vi.mocked(unifiedUpdateApi.onUpstreamAvailable).mockResolvedValue({
      edition: "cc-switch-unified-usage",
      upstreamVersion: "4.0.25",
      sourceDir: "C:/source",
      autoPrepare: true,
      phase: "preparing",
      targetVersion: "4.0.26",
      candidateDir: null,
      error: null,
    });
    const { result } = renderHook(() => useUpdate(), {
      wrapper: UpdateProvider,
    });
    await act(async () => {
      expect(await result.current.checkUpdate()).toBe(true);
    });
    expect(unifiedUpdateApi.onUpstreamAvailable).toHaveBeenCalledTimes(1);
    expect(unifiedUpdateApi.onUpstreamAvailable).toHaveBeenCalledWith("4.0.26");
    expect(result.current.updateInfo).toMatchObject({
      distribution: "upstream",
      canInstall: false,
    });
  });
  it("retains upstream availability when compatibility preparation fails instead of using a stock fallback", async () => {
    vi.mocked(checkForUpdate).mockResolvedValue(available);
    vi.mocked(unifiedUpdateApi.onUpstreamAvailable).mockRejectedValue(
      new Error("Source unavailable"),
    );
    const { result } = renderHook(() => useUpdate(), {
      wrapper: UpdateProvider,
    });
    await act(async () => {
      expect(await result.current.checkUpdate()).toBe(true);
    });
    expect(result.current.hasUpdate).toBe(true);
    expect(result.current.error).toBe("Source unavailable");
    expect(unifiedUpdateApi.onUpstreamAvailable).toHaveBeenCalledTimes(1);
  });
});
