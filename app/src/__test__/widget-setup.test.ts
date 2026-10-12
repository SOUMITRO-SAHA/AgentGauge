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
    menuBarAvailable: true,
    configured,
    setup: [],
    reason: null,
    ...overrides,
  };
}

describe("shouldOfferWidgetSetup", () => {
  it("offers setup when a successful system query confirms no widget is configured", () => {
    expect(shouldOfferWidgetSetup(status(false))).toBe(true);
  });

  it("does not offer setup when a widget is already configured", () => {
    expect(shouldOfferWidgetSetup(status(true))).toBe(false);
  });

  it("does not mistake an unknown system query for a disabled widget", () => {
    expect(shouldOfferWidgetSetup(status(null))).toBe(false);
  });

  it("does not offer setup when the build cannot provide the widget", () => {
    expect(
      shouldOfferWidgetSetup(
        status(false, { supported: false, extensionPresent: false }),
      ),
    ).toBe(false);
  });
});
