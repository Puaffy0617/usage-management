import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  onFocusChanged: vi.fn(),
  isFocused: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => native }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("native window activity", () => {
  let focusChanged: (event: { payload: boolean }) => void;
  let addedListeners: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    delete document.documentElement.dataset.windowActive;
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    addedListeners = vi.spyOn(window, "addEventListener");
    native.onFocusChanged.mockImplementation(async (handler) => {
      focusChanged = handler;
      return () => {};
    });
    native.isFocused.mockResolvedValue(true);
  });
  afterEach(() => {
    for (const [name, listener] of addedListeners.mock.calls) {
      window.removeEventListener(name as string, listener as EventListener);
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete document.documentElement.dataset.windowActive;
    delete document.documentElement.dataset.statusHeartbeat;
  });

  it("reads native focus after listener registration so an initially unfocused document cannot block an already-focused window", async () => {
    const registration = deferred<() => void>();
    native.onFocusChanged.mockReturnValue(registration.promise);
    const { initializeWindowActivity, WINDOW_ACTIVITY_EVENT } = await import(
      "@/lib/windowActivity"
    );
    const changes: boolean[] = [];
    window.addEventListener(WINDOW_ACTIVITY_EVENT, (event) =>
      changes.push((event as CustomEvent<{ active: boolean }>).detail.active),
    );
    initializeWindowActivity();
    expect(document.documentElement.dataset.windowActive).toBe("false");
    expect(native.isFocused).not.toHaveBeenCalled();
    registration.resolve(() => {});
    await settle();
    expect(native.isFocused).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.windowActive).toBe("true");
    expect(changes).toEqual([false, true]);
  });

  it("preserves a newer native focus event when the initial asynchronous snapshot arrives late", async () => {
    const snapshot = deferred<boolean>();
    native.isFocused.mockReturnValue(snapshot.promise);
    const { initializeWindowActivity } = await import("@/lib/windowActivity");
    initializeWindowActivity();
    await settle();
    expect(native.isFocused).toHaveBeenCalledOnce();
    focusChanged({ payload: true });
    snapshot.resolve(false);
    await settle();
    expect(document.documentElement.dataset.windowActive).toBe("true");
  });
});
