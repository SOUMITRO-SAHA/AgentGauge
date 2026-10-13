import { useAtomRefresh } from "@effect/atom-react";
import { useEffect } from "react";

import { systemWidgetAtom } from "~/atoms";

/**
 * How often a visible app re-reads its system widget configuration.
 *
 * WidgetKit owns the truth about placements and offers no subscription, so a
 * widget added or removed in the gallery is only visible on the next read.
 * Ten seconds keeps the sidebar honest while the user is looking at it, and
 * each read is one short IPC that answers from WidgetKit or returns at once
 * when this build cannot ask.
 */
export const SYSTEM_WIDGET_POLL_INTERVAL_MS = 10_000;

/**
 * Keeps the widget configuration current while the app is in use.
 *
 * Reads are driven by three things, because placement is a macOS action the
 * app never sees: a steady interval while the window is visible, an immediate
 * read when the window regains focus (returning from the gallery, the
 * Notification Centre, or another app), and one when the window comes back
 * from hidden. A hidden window stops the timer entirely — a background app
 * gains nothing from asking, and macOS may throttle its timers.
 *
 * Returns a teardown that removes every listener and the timer.
 */
export function startSystemWidgetPolling(
  refresh: () => void,
  intervalMs: number = SYSTEM_WIDGET_POLL_INTERVAL_MS,
): () => void {
  let timer: number | undefined;

  const stop = () => {
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };

  const start = () => {
    if (timer === undefined && intervalMs > 0) {
      timer = window.setInterval(refresh, intervalMs);
    }
  };

  const syncWithVisibility = () => {
    if (document.visibilityState === "hidden") {
      stop();
      return;
    }
    start();
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      stop();
      return;
    }
    refresh();
    start();
  };

  syncWithVisibility();
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    stop();
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