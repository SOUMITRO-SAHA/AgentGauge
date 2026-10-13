import { expect, browser, $ } from "@wdio/globals";

import {
  clearSeededStores,
  dashboardLive,
  expectDisplayed,
  gotoView,
} from "../fixtures.js";

after(async () => {
  await browser
    .execute(() => {
      delete window.__agentgaugeUpdateFixture__;
    })
    .catch(() => undefined);
  clearSeededStores();
});

describe("in-app updates", () => {
  it("stages a release update, asks before restarting, and keeps restart available", async () => {
    await dashboardLive();
    await gotoView("settings");
    await browser.execute(() => {
      window.__agentgaugeUpdateFixture__ = {
        available: true,
        version: "0.2.0",
        notes: "Maintenance release",
      };
    });

    await $('[data-testid="update-check"]').click();
    await expectDisplayed('[data-testid="update-ready-dialog"]');
    await expect($('[data-testid="update-ready-dialog"]')).toHaveText(
      expect.stringContaining("Version 0.2.0 has been downloaded and verified"),
    );
    await expect($('[data-testid="update-ready-dialog"]')).toHaveText(
      expect.stringContaining("Maintenance release"),
    );

    const installed = await browser.execute(
      () => window.__agentgaugeUpdateFixture__?.installComplete,
    );
    expect(installed).toBe(true);

    await $('[data-testid="update-later"]').click();
    await expectDisplayed('[data-testid="update-ready-inline"]');
    await $('[data-testid="update-restart-inline"]').click();

    const relaunchRequested = await browser.execute(
      () => window.__agentgaugeUpdateFixture__?.relaunchRequested,
    );
    expect(relaunchRequested).toBe(true);
  });

  it("asks before using Homebrew and offers restart only after upgrade succeeds", async () => {
    await dashboardLive();
    await gotoView("settings");
    await browser.execute(() => {
      window.__agentgaugeUpdateFixture__ = {
        available: true,
        version: "0.2.0",
        notes: "Maintenance release",
        channel: "homebrew",
      };
    });

    await $('[data-testid="update-check"]').click();
    await expectDisplayed('[data-testid="update-brew-install"]');
    expect(await browser.execute(() => window.__agentgaugeUpdateFixture__?.installComplete)).not.toBe(true);
    expect(await browser.execute(() => window.__agentgaugeUpdateFixture__?.upgradeComplete)).not.toBe(true);
    await $('[data-testid="update-brew-install"]').click();
    await expectDisplayed('[data-testid="update-restart"]');
    expect(await browser.execute(() => window.__agentgaugeUpdateFixture__?.upgradeComplete)).toBe(true);
    expect(await browser.execute(() => window.__agentgaugeUpdateFixture__?.installComplete)).not.toBe(true);
    await $('[data-testid="update-later"]').click();
    await expectDisplayed('[data-testid="update-ready-inline"]');
    await $('[data-testid="update-restart-inline"]').click();
    expect(await browser.execute(() => window.__agentgaugeUpdateFixture__?.relaunchRequested)).toBe(true);
  });

  it("does not offer restart after Homebrew fails", async () => {
    await dashboardLive();
    await gotoView("settings");
    await browser.execute(() => {
      window.__agentgaugeUpdateFixture__ = {
        available: true,
        version: "0.2.0",
        notes: "",
        channel: "homebrew",
        upgradeFailure: true,
      };
    });

    await $('[data-testid="update-check"]').click();
    await $('[data-testid="update-brew-install"]').click();
    await expectDisplayed('[data-testid="update-brew-failed"]');
    await expectDisplayed('[data-testid="update-brew-install"]');
    expect(await $('[data-testid="update-restart"]').isExisting()).toBe(false);
    expect(await browser.execute(() => window.__agentgaugeUpdateFixture__?.relaunchRequested)).not.toBe(true);
  });
});
