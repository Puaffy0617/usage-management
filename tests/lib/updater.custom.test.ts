import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkForUpdate } from "@/lib/updater";

const native = vi.hoisted(() => ({
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
  downloadAndInstall: vi.fn(),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "4.0.25-usage.1"),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: native.check }));

describe("Custom edition upstream update detection", () => {
  beforeEach(() => {
    native.check.mockResolvedValue({
      version: "4.0.26",
      notes: "Upstream changes",
      ...native,
    });
  });
  it("marks stock releases advisory and performs no download or installation", async () => {
    expect(await checkForUpdate()).toEqual({
      status: "available",
      info: {
        currentVersion: "4.0.25-usage.1",
        availableVersion: "4.0.26",
        notes: "Upstream changes",
        pubDate: undefined,
        distribution: "upstream",
        canInstall: false,
      },
    });
    expect(native.check).toHaveBeenCalledTimes(1);
    expect(native.download).not.toHaveBeenCalled();
    expect(native.install).not.toHaveBeenCalled();
    expect(native.downloadAndInstall).not.toHaveBeenCalled();
  });
  it.each(["4.0.25", "4.0.24", "4.0.25-rc.1"])(
    "does not misreport stock %s as a new upstream base for a custom prerelease",
    async (version) => {
      native.check.mockResolvedValue({ version });
      expect(await checkForUpdate()).toEqual({ status: "up-to-date" });
      expect(native.downloadAndInstall).not.toHaveBeenCalled();
    },
  );
});
