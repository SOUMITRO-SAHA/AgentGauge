/**
 * Tests for the size formatter the Processes screen renders.
 *
 * Decimal (1000-based) units, matching how macOS itself reports sizes, with
 * one decimal below 100 so readouts stay compact but distinguishable.
 */

import { describe, expect, it } from "vitest";

import { formatBytes } from "~/lib/format";

describe("formatBytes", () => {
  it("renders bytes below a kilobyte without a fraction", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(999)).toBe("999 B");
  });

  it("uses decimal units, the way macOS reports sizes", () => {
    expect(formatBytes(1_000)).toBe("1 kB");
    expect(formatBytes(1_000_000)).toBe("1 MB");
    expect(formatBytes(1_000_000_000)).toBe("1 GB");
  });

  it("keeps one decimal above a kilobyte until the unit carries the number", () => {
    expect(formatBytes(1_500)).toBe("1.5 kB");
    expect(formatBytes(432_000_000)).toBe("432 MB");
    expect(formatBytes(2_400_000_000)).toBe("2.4 GB");
  });

  it("never claims a unit beyond terabytes", () => {
    expect(formatBytes(3_000_000_000_000)).toBe("3 TB");
    expect(formatBytes(9_999_000_000_000_000)).toBe("9999 TB");
  });
});
