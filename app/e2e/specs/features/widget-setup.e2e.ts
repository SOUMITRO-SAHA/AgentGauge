import { expect, $, browser } from "@wdio/globals";

import {
  clearSeededStores,
  dashboardLive,
  expectDisplayed,
} from "../fixtures.js";

after(() => {
  clearSeededStores();
});

describe("system widget setup action", () => {
  beforeEach(async () => {
    await dashboardLive({ widgetConfigured: false });
  });

  it("highlights setup when absent and opens the focused gallery guide", async () => {
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
});
