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
  it("re-reads on the interval while the window is visible", () => {
    const refresh = vi.fn();
    startSystemWidgetPolling(refresh, INTERVAL_MS);

    vi.advanceTimersByTime(INTERVAL_MS * 3);

    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("re-reads as soon as the window regains focus", () => {
    const refresh = vi.fn();
    startSystemWidgetPolling(refresh, INTERVAL_MS);

    window.dispatchEvent(new Event("focus"));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops asking while hidden and reads once when shown again", () => {
    const refresh = vi.fn();
    startSystemWidgetPolling(refresh, INTERVAL_MS);

    setVisibility("hidden");
    vi.advanceTimersByTime(INTERVAL_MS * 3);
    expect(refresh).not.toHaveBeenCalled();

    setVisibility("visible");
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("stops entirely once torn down", () => {
    const refresh = vi.fn();
    const stop = startSystemWidgetPolling(refresh, INTERVAL_MS);

    stop();
    vi.advanceTimersByTime(INTERVAL_MS * 3);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));

    expect(refresh).not.toHaveBeenCalled();
  });
});