import { $, browser, expect } from "@wdio/globals";

import {
  clearSeededStores,
  clickDisplayed,
  dashboardWithSlowCodexLocalUsage,
  dashboardWithSlowCodexStats,
  expectDisplayed,
  gotoView,
} from "../../fixtures.js";

after(() => {
  clearSeededStores();
});

describe("Stats Codex loading", () => {
  it("shows quota readings while Codex activity is still loading", async () => {
    await dashboardWithSlowCodexStats();
    await gotoView("stats");

    await expect(
      $('[data-testid="stats-plan-row-codex-window"]'),
    ).toHaveText(/12% used/);
    await clickDisplayed('[data-testid="stats-tab-codex"]');

    await expectDisplayed(
      '[data-testid="stats-account-analytics"] [data-testid="stats-analytics-skeleton"]',
    );
    await expect(
      $(
        '[data-testid="stats-plan-reading"] [data-testid="stats-plan-window-used-5h"]',
      ),
    ).toHaveText(/12% used/);
    expect(
      await $$(
        '[data-testid="stats-plan-reading"] [data-testid="stats-reading-skeleton"]',
      ),
    ).toHaveLength(0);

    await expectDisplayed('[data-testid="stats-total-tokens"]');
    await expectDisplayed('[data-testid="stats-plan-window-used-5h"]');
    await expect(
      $(
        '[data-testid="stats-account-analytics"] [data-testid="stats-analytics-skeleton"]',
      ),
    ).not.toBeDisplayed();
    expect(
      await $$(
        '[data-testid="stats-plan-reading"] [data-testid="stats-reading-skeleton"]',
      ),
    ).toHaveLength(0);

    const tokens = await browser.execute(
      () =>
        document.querySelector('[data-testid="stats-total-tokens"]')
          ?.textContent,
    );
    expect(/1[.,]23M/.test(tokens ?? "")).toBe(true);
  });

  it("shows API activity while local rollout analytics are still loading", async () => {
    await dashboardWithSlowCodexLocalUsage();
    await gotoView("stats");
    await clickDisplayed('[data-testid="stats-tab-codex"]');

    await expectDisplayed('[data-testid="stats-total-tokens"]');
    await expectDisplayed('[data-testid="stats-local-logs-skeleton"]');
    await expect(
      $(
        '[data-testid="stats-account-analytics"] [data-testid="stats-analytics-skeleton"]',
      ),
    ).not.toBeDisplayed();
    expect(await $$('[data-testid="stats-local-logs"]')).toHaveLength(0);

    await expectDisplayed('[data-testid="stats-local-logs"]');
    await expect(
      $('[data-testid="stats-local-logs-skeleton"]'),
    ).not.toBeDisplayed();
  });
});
