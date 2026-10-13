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
    placedKinds: configured === true ? ["AIStatsUsageWidget"] : [],
    menuBarAvailable: true,
    setup: [],
    reason: null,
    ...overrides,
  };
}

describe("shouldOfferWidgetSetup", () => {
  it("offers setup when no AgentGauge widget is placed", () => {
    expect(shouldOfferWidgetSetup(status(false))).toBe(true);
  });

  it("stands down once a widget is confirmed configured", () => {
    expect(shouldOfferWidgetSetup(status(true))).toBe(false);
  });

  it("stands down when the sibling build's widget is the one on this Mac", () => {
    // The query cannot see another build's widget, so this is the receipt path:
    // a Debug widget the user can see must not make Release ask for another one.
    expect(
      shouldOfferWidgetSetup(
        status(false, {
          configuredKinds: [],
          placedKinds: ["AIStatsUsageWidgetDev"],
        }),
      ),
    ).toBe(false);
  });

  it("stands down when both builds' widgets are placed", () => {
    expect(
      shouldOfferWidgetSetup(
        status(false, {
          configuredKinds: ["AIStatsUsageWidget"],
          placedKinds: ["AIStatsUsageWidget", "AIStatsUsageWidgetDev"],
        }),
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

  it("stands down on a receipt even when this build cannot ask WidgetKit", () => {
    expect(
      shouldOfferWidgetSetup(
        status(null, {
          extensionPresent: false,
          placedKinds: ["AIStatsUsageWidgetDev"],
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