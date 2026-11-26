import { browser, expect } from "@wdio/globals";

import {
  clearSeededStores,
  clickDisplayed,
  dashboardLive,
  dashboardWithAntigravity,
  expectDisplayed,
  gotoView,
} from "../fixtures.js";

after(() => {
  clearSeededStores();
});

describe("Antigravity local session stats", () => {
  it("keeps the Antigravity tab out of Stats while its CLI is not detected", async () => {
    await dashboardLive();
    await gotoView("stats");

    const present = await browser.execute(
      () =>
        document.querySelector('[data-testid="stats-tab-antigravity"]') !== null,
    );
    expect(present).toBe(false);
  });

  it("renders the session record once the CLI is detected, without token figures", async () => {
    await dashboardWithAntigravity();
    await gotoView("stats");

    await clickDisplayed('[data-testid="stats-tab-antigravity"]');
    await expectDisplayed('[data-testid="stats-antigravity-activity"]');
    await expectDisplayed('[data-testid="stats-antigravity-summary"]');
    await expectDisplayed('[data-testid="stats-local-session-chart"]');

    const panel = await browser.execute(() => {
      const read = (id: string) =>
        document
          .querySelector(`[data-testid="${id}"]`)
          ?.textContent?.replace(/\s+/g, " ") ?? "";
      return {
        summary: read("stats-antigravity-summary"),
        activity: read("stats-antigravity-activity"),
        reading: read("stats-plan-reading"),
      };
    });

    expect(panel.summary).toContain("7 sessions");
    expect(panel.summary).toContain("2026-11-21 → 2026-11-26");
    expect(panel.activity).toContain("does not record token counts");
    expect(panel.reading).toContain("does not report token history");
  });

  it("answers the all-plans row with session counts, never a fabricated zero", async () => {
    await dashboardWithAntigravity();
    await gotoView("stats");

    await clickDisplayed('[data-testid="stats-tab-all"]');
    await expectDisplayed('[data-testid="stats-plan-row-antigravity"]');

    const row = await browser.execute(() => {
      const read = (id: string) =>
        document
          .querySelector(`[data-testid="${id}"]`)
          ?.textContent?.replace(/\s+/g, " ") ?? "";
      return {
        tokens: read("stats-plan-row-antigravity-tokens"),
        coverage: read("stats-plan-row-antigravity-source"),
        cost: read("stats-plan-row-antigravity-cost"),
      };
    });

    expect(row.tokens).toBe("7 sessions · no token counts");
    expect(row.coverage).toContain("7 local sessions");
    expect(row.coverage).toContain("2026-11-21 → 2026-11-26");
    expect(row.cost).toBe("No cost recorded");
  });
});
