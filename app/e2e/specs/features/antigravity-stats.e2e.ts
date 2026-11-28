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

  it("shows quota windows on the Usage tab while the CLI is detected", async () => {
    await dashboardWithAntigravity();
    await gotoView("home");

    await clickDisplayed('[data-testid="usage-tab-antigravity"]');
    await expectDisplayed('[data-testid="usage-antigravity-pointer"]');

    const panel = await browser.execute(() => {
      const read = (id: string) =>
        document
          .querySelector(`[data-testid="${id}"]`)
          ?.textContent?.replace(/\s+/g, " ") ?? "";
      return {
        bars: document.querySelectorAll('[data-testid="window-bar"]').length,
        unavailableAbsent:
          document.querySelector('[data-testid="window-unavailable"]') === null,
        pointer: read("usage-antigravity-pointer"),
        headline: read("home-window"),
      };
    });

    expect(panel.bars).toBe(4);
    expect(panel.unavailableAbsent).toBe(true);
    expect(panel.pointer).toContain("/usage");
    expect(panel.pointer).toContain("Stats view");
    // The headline is the soonest-resetting window (Gemini's 5-hour), since
    // no single window is promoted as "the" five-hour one.
    expect(panel.headline).toContain("Gemini 5h");
  });

  it("keeps the Usage tab out of the strip while the CLI is not detected", async () => {
    await dashboardLive();
    await gotoView("home");

    const present = await browser.execute(
      () =>
        document.querySelector('[data-testid="usage-tab-antigravity"]') !==
        null,
    );
    expect(present).toBe(false);
  });

  it("tracks the agy process group and its storage on the Processes screen", async () => {
    await dashboardWithAntigravity();
    await gotoView("processes");

    await clickDisplayed('[data-testid="process-tab-antigravity"]');
    await expectDisplayed('[data-testid="process-panel-antigravity"]');

    const panel = await browser.execute(() => {
      const read = (id: string) =>
        document
          .querySelector(`[data-testid="${id}"]`)
          ?.textContent?.replace(/\s+/g, " ") ?? "";
      return {
        group: read("process-panel-antigravity"),
        storageRows: Array.from(
          document.querySelectorAll(
            '[data-testid^="process-storage-row-antigravity"]',
          ),
        ).length,
      };
    });

    expect(panel.group).toContain("agy");
    expect(panel.group).toContain("CLI surface");
    expect(panel.storageRows).toBe(3);
  });
});
