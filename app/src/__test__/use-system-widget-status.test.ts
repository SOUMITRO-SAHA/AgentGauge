import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startSystemWidgetPolling } from "~/hooks/use-system-widget-status";

const INTERVAL_MS = 1_000;

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startSystemWidgetPolling", () => {
  it("re-reads on the interval while the app is open", () => {
    const refresh = vi.fn();
    startSystemWidgetPolling(refresh, INTERVAL_MS);

    vi.advanceTimersByTime(INTERVAL_MS * 3);

    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("keeps re-reading while the window is open but not frontmost", () => {
    // The macOS webview reports `hidden` for windows that are merely occluded,
    // and a gate on that would stop detection exactly when it is needed.
    const refresh = vi.fn();
    startSystemWidgetPolling(refresh, INTERVAL_MS);

    setVisibility("hidden");
    vi.advanceTimersByTime(INTERVAL_MS * 3);

    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("re-reads as soon as the window comes back to the front", () => {
    const refresh = vi.fn();
    startSystemWidgetPolling(refresh, INTERVAL_MS);
    refresh.mockClear();

    setVisibility("hidden");
    setVisibility("visible");

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("re-reads as soon as the window regains focus", () => {
    const refresh = vi.fn();
    startSystemWidgetPolling(refresh, INTERVAL_MS);

    window.dispatchEvent(new Event("focus"));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops entirely once torn down", () => {
    const refresh = vi.fn();
    const stop = startSystemWidgetPolling(refresh, INTERVAL_MS);

    stop();
    vi.advanceTimersByTime(INTERVAL_MS * 3);
    window.dispatchEvent(new Event("focus"));
    setVisibility("visible");

    expect(refresh).not.toHaveBeenCalled();
  });
});