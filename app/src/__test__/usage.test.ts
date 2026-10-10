/**
 * The honesty rules, stated as tests.
 *
 * These are the invariants that stop the UI showing a number without its
 * provenance, or a bar that runs the opposite way round. They pin the pure
 * helpers so a refactor cannot quietly break one.
 */

import { describe, expect, it } from "vitest";

import {
  formatCountdown,
  formatFreshness,
  formatPlan,
  formatUsed,
  millisUntilReset,
  safeResetAt,
  toneFor,
  windowTitle,
} from "~/lib/usage";

describe("toneFor", () => {
  it("reports an unavailable reading as unknown, not healthy", () => {
    expect(
      toneFor({ usedPercent: 0, freshness: "unavailable", permission: "allowed" }),
    ).toBe("unknown");
  });

  it("never reports an unknown permission as healthy", () => {
    // The provider documents that null means "unavailable"; showing it as
    // healthy is the specific mistake this guards against.
    expect(
      toneFor({ usedPercent: 1, freshness: "live", permission: "unknown" }),
    ).toBe("unknown");
  });

  it("reports a blocked account as critical even at zero usage", () => {
    expect(
      toneFor({ usedPercent: 0, freshness: "live", permission: "blocked" }),
    ).toBe("critical");
  });

  it("escalates as the window fills", () => {
    const base = { freshness: "live", permission: "allowed" } as const;
    expect(toneFor({ ...base, usedPercent: 10 })).toBe("healthy");
    expect(toneFor({ ...base, usedPercent: 75 })).toBe("warning");
    expect(toneFor({ ...base, usedPercent: 90 })).toBe("critical");
  });
});

describe("safeResetAt", () => {
  it("rejects a zero reset time", () => {
    // Rendering it would show 1970 as though it were a measurement.
    expect(safeResetAt(0)).toBeNull();
  });

  it("rejects a negative reset time", () => {
    expect(safeResetAt(-1)).toBeNull();
  });

  it("passes a plausible reset time through", () => {
    expect(safeResetAt(1_791_561_936)).toBe(1_791_561_936);
  });
});

describe("millisUntilReset", () => {
  const now = 1_000_000;

  it("returns null when there is no reset time", () => {
    expect(millisUntilReset(null, now)).toBeNull();
  });

  it("converts the provider's seconds into milliseconds", () => {
    // A reset 1_800 seconds ahead of "now" is 30 minutes away.
    expect(millisUntilReset(1_800, 0)).toBe(1_800_000);
  });

  it("floors a past reset at zero rather than going negative", () => {
    // A past time means the window is rolling; a negative countdown reads broken.
    expect(millisUntilReset(1, 1_000)).toBe(0);
  });
});

describe("formatCountdown", () => {
  it("returns null when there is nothing to show", () => {
    expect(formatCountdown(null)).toBeNull();
  });

  it("formats hours and minutes", () => {
    const fourHoursTwelve = (4 * 60 + 12) * 60_000;
    expect(formatCountdown(fourHoursTwelve)).toBe("4h 12m");
  });

  it("formats minutes alone", () => {
    expect(formatCountdown(12 * 60_000)).toBe("12m");
  });

  it("formats days and hours", () => {
    expect(formatCountdown(2 * 24 * 60 * 60_000)).toBe("2d 0h");
  });

  it("shows less than a minute rather than zero", () => {
    expect(formatCountdown(30_000)).toBe("<1m");
  });
});

describe("formatFreshness", () => {
  it("returns null for a reading with no timestamp", () => {
    expect(formatFreshness(null, 1_000)).toBeNull();
  });

  it("reports a sub-minute reading as just now", () => {
    expect(formatFreshness(1_000, 30_000)).toBe("just now");
  });

  it("reports minutes", () => {
    expect(formatFreshness(0, 5 * 60_000)).toBe("5 min ago");
  });

  it("reports hours", () => {
    expect(formatFreshness(0, 3 * 60 * 60_000)).toBe("3 h ago");
  });
});

describe("windowTitle", () => {
  it("spells out the five hour window", () => {
    expect(windowTitle("5h", 300)).toBe("5-hour window");
  });

  it("titles the weekly window", () => {
    expect(windowTitle("weekly", 10_080)).toBe("Weekly limit");
  });

  it("falls back to the label when there is no duration", () => {
    expect(windowTitle("usage", null)).toBe("usage");
  });
});

describe("formatUsed", () => {
  it("always says used, so the bar cannot be read backwards", () => {
    expect(formatUsed(12)).toBe("12% used");
  });
});

describe("formatPlan", () => {
  it("renders an unknown plan as a placeholder, never as a real tier", () => {
    expect(formatPlan(null)).toBe("Unknown plan");
    expect(formatPlan("unknown")).toBe("Unknown plan");
  });

  it("renders known tiers readably", () => {
    expect(formatPlan("team")).toBe("Team");
    expect(formatPlan("proLite")).toBe("Pro Lite");
  });
});