import { useAtomRefresh } from "@effect/atom-react";
import { useEffect } from "react";

import { systemWidgetAtom } from "~/atoms";

/**
 * How often an open app re-reads its system widget configuration.
 *
 * WidgetKit owns the truth about placements and offers no subscription, so a
 * widget added or removed in the gallery is only visible on the next read. Ten
 * seconds keeps the sidebar honest while the user is looking at it, and each
 * read is one short IPC that answers from WidgetKit or returns at once when this
 * build cannot ask.
 */
export const SYSTEM_WIDGET_POLL_INTERVAL_MS = 10_000;

/**
 * Keeps the widget configuration current while the app is open.
 *
 * Driven by three things, because placement is a macOS action the app never
 * sees: a steady interval, an immediate read when the window regains focus
 * (returning from the gallery, the Notification Centre, or another app), and one
 * when the window comes back from hidden.
 *
 * The interval does not stop when the window is occluded or the app is in the
 * background. `document.visibilityState` is not a reliable proxy for "the user
 * is looking" — the macOS webview reports `hidden` for a window that is open and
 * perfectly capable of showing the answer — so gating on it silently disabled
 * detection in exactly the sessions that needed it. The cost of not gating is
 * one small IPC every ten seconds; macOS throttles timers for occluded windows
 * anyway.
 *
 * Returns a teardown that removes every listener and the timer.
 */
export function startSystemWidgetPolling(
  refresh: () => void,
  intervalMs: number = SYSTEM_WIDGET_POLL_INTERVAL_MS,
): () => void {
  const timer =
    intervalMs > 0 ? window.setInterval(refresh, intervalMs) : undefined;

  const onVisibilityChange = () => {
    if (document.visibilityState !== "hidden") {
      refresh();
    }
  };

  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    if (timer !== undefined) {
      window.clearInterval(timer);
    }
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

/**
 * Mounts the widget-status polling for as long as the shell is mounted.
 *
 * The app shell is always mounted, so placement changes are picked up on any
 * screen, not only where the guide happens to be open.
 */
export function useSystemWidgetStatusPolling(): void {
  const refresh = useAtomRefresh(systemWidgetAtom);
  useEffect(() => startSystemWidgetPolling(refresh), [refresh]);
}