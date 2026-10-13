import { expect, $ } from "@wdio/globals";

import {
  clickDisplayed,
  dashboardLive,
  dispatchCalls,
  expectDisplayed,
  gotoView,
} from "../../fixtures.js";

/**
 * The removable-volume gate in Stats: one dialog that explains the macOS
 * permission prompt before it appears, a grant that records consent and
 * clears the way for the analytics, and a dismiss path that is a real
 * choice — the stats render either way, and only a grant is remembered.
 */
describe("volume access gate", () => {
  it("shows the access dialog instead of mounting stats until consent lands", async () => {
    await dashboardLive({ volumeAccessNeeded: true });
    await gotoView("stats");

    await expectDisplayed('[data-testid="volume-access-dialog"]');
    expect(
      await $('[data-testid="volume-access-dialog"]').getText(),
    ).toContain("removable volume");

    await clickDisplayed('[data-testid="volume-access-grant"]');

    await expectDisplayed('[data-testid="stats-tab-codex"]');
    expect(
      await $('[data-testid="volume-access-dialog"]').isExisting(),
    ).toBe(false);
    expect(
      (await dispatchCalls()).some(
        (call) => call.type === "grantVolumeAccess",
      ),
    ).toBe(true);
  });

  it("Not now keeps the analytics reachable and records no consent", async () => {
    await dashboardLive({ volumeAccessNeeded: true });
    await gotoView("stats");

    await expectDisplayed('[data-testid="volume-access-dialog"]');
    await clickDisplayed('[data-testid="volume-access-dismiss"]');

    await expectDisplayed('[data-testid="stats-tab-codex"]');
    expect(
      await $('[data-testid="volume-access-dialog"]').isExisting(),
    ).toBe(false);
    expect(
      (await dispatchCalls()).some(
        (call) => call.type === "grantVolumeAccess",
      ),
    ).toBe(false);
  });

  it("stays away when the data roots are on the boot volume", async () => {
    await dashboardLive();
    await gotoView("stats");

    await expectDisplayed('[data-testid="stats-tab-codex"]');
    expect(
      await $('[data-testid="volume-access-dialog"]').isExisting(),
    ).toBe(false);
  });
});
