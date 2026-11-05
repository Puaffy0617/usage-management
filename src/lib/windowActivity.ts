import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const HEARTBEAT_INTERVAL_MS = 3000;
const HEARTBEAT_DIM_MS = 300;
export const WINDOW_ACTIVITY_EVENT = "cc-switch:window-activity";

let initialized = false;
let heartbeatInterval: number | undefined;
let heartbeatReset: number | undefined;

function stopHeartbeat() {
  if (heartbeatInterval !== undefined) {
    window.clearInterval(heartbeatInterval);
    heartbeatInterval = undefined;
  }
  if (heartbeatReset !== undefined) {
    window.clearTimeout(heartbeatReset);
    heartbeatReset = undefined;
  }
  delete document.documentElement.dataset.statusHeartbeat;
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = window.setInterval(() => {
    document.documentElement.dataset.statusHeartbeat = "true";
    heartbeatReset = window.setTimeout(() => {
      delete document.documentElement.dataset.statusHeartbeat;
      heartbeatReset = undefined;
    }, HEARTBEAT_DIM_MS);
  }, HEARTBEAT_INTERVAL_MS);
}

function setWindowActive(active: boolean) {
  const changed =
    document.documentElement.dataset.windowActive !== String(active);
  document.documentElement.dataset.windowActive = String(active);

  if (active) {
    startHeartbeat();
  } else {
    stopHeartbeat();
  }
  if (changed)
    window.dispatchEvent(
      new CustomEvent(WINDOW_ACTIVITY_EVENT, { detail: { active } }),
    );
}

export function initializeWindowActivity() {
  if (initialized) return;
  initialized = true;

  let focusRevision = 0;
  const observeFocus = (active: boolean) => {
    focusRevision += 1;
    setWindowActive(active);
  };
  observeFocus(document.hasFocus());

  // Browser focus events are a fallback for non-Tauri renderer tests and dev mode.
  window.addEventListener("focus", () => observeFocus(true));
  window.addEventListener("blur", () => observeFocus(false));

  if (isTauri()) {
    const nativeWindow = getCurrentWindow();
    void (async () => {
      await nativeWindow.onFocusChanged(({ payload }) => observeFocus(payload));
      // The window can become focused before this asynchronous listener is
      // registered. Read its current state, but never overwrite a newer event
      // with an older snapshot returned by the native bridge.
      const revision = focusRevision;
      const active = await nativeWindow.isFocused();
      if (revision === focusRevision) setWindowActive(active);
    })().catch((error) => {
      console.error("Failed to observe window focus changes", error);
    });
  }
}
