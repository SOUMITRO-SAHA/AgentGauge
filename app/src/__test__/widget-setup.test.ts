import { describe, expect, it } from "vitest";

import type { SystemWidgetStatus } from "~/lib/ipc";
import { shouldOfferWidgetSetup } from "~/lib/widget-setup";

function status(
  configured: boolean | null,
  overrides: Partial<SystemWidgetStatus> = {},
): SystemWidgetStatus {
  return {
    supported: true,
    system: "widgetKit",
    osVersion: "27.0",
    minimumVersion: "14.0",
    extensionBundled: true,
    extensionPresent: true,
    snapshotWritten: true,
    configured,
    configuredKinds: [],
    menuBarAvailable: true,
    setup: [],
    reason: null,
    ...overrides,
  };
}

describe("shouldOfferWidgetSetup", () => {
  it("offers setup when a successful system query confirms no widget is configured", () => {
    expect(shouldOfferWidgetSetup(status(false))).toBe(true);
  });

  it("stands down once a widget is confirmed configured", () => {
    expect(
      shouldOfferWidgetSetup(
        status(true, { configuredKinds: ["AIStatsUsageWidget"] }),
      ),
    ).toBe(false);
  });

  it("keeps the guide reachable when the system query is unavailable", () => {
    // Detection failing is exactly when a user needs the setup steps; hiding
    // the only route to them leaves no way forward.
    expect(shouldOfferWidgetSetup(status(null))).toBe(true);
  });

  it("keeps the guide reachable in a build with no embedded extension", () => {
    expect(
      shouldOfferWidgetSetup(
        status(null, { extensionPresent: false, snapshotWritten: false }),
      ),
    ).toBe(true);
  });

  it("stands down when the other build's widget is the one configured", () => {
    // Placement is a macOS action the app cannot undo, and the guide would
    // only ask the user to place a second widget they already have.
    expect(
      shouldOfferWidgetSetup(
        status(false, { configuredKinds: ["AIStatsUsageWidgetDev"] }),
      ),
    ).toBe(false);
  });

  it("stands down when both builds' widgets are configured", () => {
    expect(
      shouldOfferWidgetSetup(
        status(false, {
          configuredKinds: ["AIStatsUsageWidget", "AIStatsUsageWidgetDev"],
        }),
      ),
    ).toBe(false);
  });

  it("never offers setup where the platform has no system widget", () => {
    expect(
      shouldOfferWidgetSetup(
        status(null, {
          supported: false,
          system: "none",
          reason: "macOS only",
        }),
      ),
    ).toBe(false);
  });
});