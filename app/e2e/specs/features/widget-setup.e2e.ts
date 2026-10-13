import { expect, $, browser } from "@wdio/globals";

import {
  clearSeededStores,
  dashboardLive,
  expectDisplayed,
  installDispatch,
  liveSnapshot,
} from "../fixtures.js";

after(() => {
  clearSeededStores();
});

describe("system widget setup action", () => {
  it("highlights setup when absent and opens the focused gallery guide", async () => {
    await dashboardLive({ widgetConfigured: false });
    const setup = $('[data-testid="nav-widget-setup"]');
    await expectDisplayed('[data-testid="nav-widget-setup"]');
    await expect(setup).toHaveText("Set up widget");

    const highlight = await browser.execute(() => {
      const button = document.querySelector(
        '[data-testid="nav-widget-setup"]',
      );
      const probe = document.createElement("span");
      probe.style.color = getComputedStyle(document.documentElement)
        .getPropertyValue("--brand-teal");
      document.body.append(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return button ? getComputedStyle(button).backgroundColor === expected : false;
    });
    expect(highlight).toBe(true);

    await setup.click();
    await expectDisplayed('[data-testid="view-settings"]');
    await expectDisplayed('[data-testid="widget-panel"]');
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="widget-panel"]').getAttribute(
          "data-highlighted",
        )) === "true",
      { timeout: 5000, timeoutMsg: "widget guide was not highlighted" },
    );
    await expect($('[data-testid="widget-status"]')).toHaveAttribute(
      "data-state",
      "not-configured",
    );
    await expectDisplayed('[data-testid="widget-setup-steps"]');
  });

  it("stands down when the other build's widget is the one configured", async () => {
    await dashboardLive({
      widgetConfigured: false,
      widgetConfiguredKinds: ["AIStatsUsageWidgetDev"],
    });

    expect(await $('[data-testid="nav-widget-setup"]').isExisting()).toBe(false);

    await gotoSettings();
    const status = $('[data-testid="widget-status"]');
    await expectDisplayed('[data-testid="widget-status"]');
    await expect(status).toHaveAttribute("data-state", "configured-other-build");
    await expect(status).toHaveText(
      expect.stringContaining("AgentGauge Dev"),
    );
    await expectDisplayed('[data-testid="widget-setup-steps"]');
  });

  it("keeps setup reachable when the system query cannot answer", async () => {
    await dashboardLive({ widgetConfigured: null });

    // Detection failing is exactly when the steps matter most. The panel still
    // refuses to claim the widget is absent.
    await expectDisplayed('[data-testid="nav-widget-setup"]');
    await gotoSettings();
    const status = $('[data-testid="widget-status"]');
    await expectDisplayed('[data-testid="widget-status"]');
    await expect(status).toHaveAttribute("data-state", "unknown");
    await expect(status).toHaveText(expect.stringContaining("could not check"));
    await expectDisplayed('[data-testid="widget-setup-steps"]');
  });

  it("picks up a placement on its own, with no refresh asked for", async () => {
    await dashboardLive({ widgetConfigured: true });
    expect(await $('[data-testid="nav-widget-setup"]').isExisting()).toBe(false);

    // WidgetKit owns placement and offers no subscription, so the app re-reads
    // on a timer. Nothing here refocuses the window or presses Refresh: the
    // affordance has to appear because detection is live.
    await installDispatch({
      visible: false,
      usage: liveSnapshot(),
      installed: true,
      version: "codex-cli 0.159.0",
      widgetEmbedded: true,
      widgetSupported: true,
      widgetConfigured: false,
      automationRunning: true,
    });

    await browser.waitUntil(
      async () =>
        (await $('[data-testid="nav-widget-setup"]').isExisting()) === true,
      {
        timeout: 20_000,
        timeoutMsg: "the setup action never appeared on its own",
      },
    );
  });
});

async function gotoSettings(): Promise<void> {
  await $('[data-testid="nav-settings"]').click();
  await expectDisplayed('[data-testid="view-settings"]');
}
