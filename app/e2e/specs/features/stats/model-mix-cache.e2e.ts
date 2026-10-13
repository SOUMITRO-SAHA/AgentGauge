import { browser, expect } from "@wdio/globals";

import {
  clearSeededStores,
  clickDisplayed,
  dashboardWithZaiAnalytics,
  expectDisplayed,
  gotoView,
} from "../../fixtures.js";

after(() => {
  clearSeededStores();
});

describe("Stats prompt cache card", () => {
  it("answers with the provider's own cache-hit rate, not a plan-value ratio", async () => {
    await dashboardWithZaiAnalytics();
    await gotoView("stats");

    await clickDisplayed('[data-testid="stats-tab-zai"]');
    await expectDisplayed('[data-testid="stats-model-mix"]');
    await expectDisplayed('[data-testid="stats-model-mix-cache"]');

    const card = await browser.execute(() => {
      const read = (id: string) =>
        document
          .querySelector(`[data-testid="${id}"]`)
          ?.textContent?.replace(/\s+/g, " ") ?? "";
      return {
        cache: read("stats-model-mix-cache"),
        ratioCardExists:
          document.querySelector('[data-testid="stats-value-ratio"]') !== null,
      };
    });

    // Z.AI publishes 0.9747 for the same 30-day window the mix covers, and the
    // caption names the tokens that rate is a share of.
    expect(card.cache).toContain("Prompt cache");
    expect(card.cache).toContain("97.5%");
    expect(card.cache).toContain("16B prompt tokens were cache reads");
    expect(card.cache).toContain("30 days");
    // The ratio card this replaced is gone, so nothing claims a multiple of the
    // plan price from an estimate.
    expect(card.ratioCardExists).toBe(false);
  });
});
