import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { DatabaseUpgrade } from "@/components/DatabaseUpgrade";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/plugin-process", () => ({ exit: vi.fn() }));
describe("Custom database recovery", () => {
  it("never checks or installs stock updates when the schema is too new", () => {
    render(
      <DatabaseUpgrade
        payload={{
          db_version: 30,
          supported_version: 25,
          path: "C:/cc-switch.db",
        }}
      />,
    );
    expect(
      screen.getByText("A compatible custom build is required"),
    ).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /install|upgrade|retry/i }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "View upstream release notes" }),
    );
    expect(invoke).toHaveBeenCalledWith("open_external", expect.any(Object));
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) =>
          [
            "install_update_and_restart",
            "check_app_update_available",
            "check_for_updates",
          ].includes(command),
        ),
    ).toBe(false);
  });
});
