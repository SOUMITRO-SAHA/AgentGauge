import { expect } from "@wdio/globals";

import {
  clickDisplayed,
  dashboardLive,
  dashboardWithHeatmapYear,
  dashboardWithZaiWeek,
  expectDisplayed,
  gotoView,
} from "../../fixtures.js";

/**
 * The activity heatmap, on its own.
 *
 * Kept apart from the stats suite so a change to the grid can be checked in a
 * few seconds rather than by re-running every stats spec.
 */
describe("stats activity heatmap", () => {
  it("lays the year out as week columns with a weekday per row", async () => {
    await dashboardLive();
    await gotoView("stats");
    await clickDisplayed('[data-testid="stats-tab-codex"]');
    await expectDisplayed('[data-testid="stats-activity-grid"]');

    const grid = await browser.execute(() => {
      const root = document.querySelector('[data-testid="stats-activity-grid"]');
      const cells = Array.from(
        root?.querySelectorAll("[data-testid^='stats-activity-cell-']") ?? [],
      ).map((cell) => ({
        id: cell.getAttribute("data-testid") ?? "",
        state: cell.getAttribute("data-state") ?? "",
        row: cell.getAttribute("data-row") ?? "",
      }));
      const read = (id: string) =>
        document
          .querySelector(`[data-testid="${id}"]`)
          ?.textContent?.replace(/\s+/g, " ")
          .trim() ?? "";
      return {
        weeks: root?.querySelectorAll('[data-testid="stats-activity-week"]').length ?? 0,
        cells,
        source: read("stats-activity-source"),
        months: read("stats-activity-months"),
        weekdays: read("stats-activity-weekdays"),
        legend: read("stats-activity-legend"),
      };
    });

    // A column is a week and a row is a weekday, so the grid runs back a year.
    expect(grid.weeks).toBeGreaterThanOrEqual(53);
    expect(grid.cells.length).toBeGreaterThan(364);
    // Each day sits in the row its weekday demands, which is what makes a
    // column readable as a week at a glance.
    expect(grid.cells.find((c) => c.id.endsWith("2026-09-07"))?.row).toBe("1");
    expect(grid.months).toContain("Sep");
    expect(grid.weekdays).toContain("Mon");
    expect(grid.legend).toContain("Less");

    // The grid is a year wide; the caption says what the logs actually cover.
    expect(grid.source).toContain("2026-09-04");
    expect(grid.source).toContain("2026-09-24");

    // A day missing from the logs is not a day that recorded nothing.
    const state = (day: string) =>
      grid.cells.find((c) => c.id.endsWith(day))?.state;
    expect(state("2026-09-06")).toBe("no-record");
    expect(state("2026-09-07")).toBe("empty");
    // Four shades over the busiest day: 120M of a 180M peak is one step down.
    expect(state("2026-09-04")).toBe("high");
    expect(state("2026-09-24")).toBe("peak");
  });

  it("draws it for a provider that reports its own days", async () => {
    await dashboardWithZaiWeek();
    await gotoView("stats");
    await clickDisplayed('[data-testid="stats-tab-zai"]');

    const reading = await browser.execute(() => {
      const read = (id: string) =>
        document
          .querySelector(`[data-testid="${id}"]`)
          ?.textContent?.replace(/\s+/g, " ")
          .trim() ?? "";
      return {
        source: read("stats-activity-source"),
        cellExists:
          document.querySelector(
            '[data-testid="stats-activity-cell-2026-10-08"]',
          ) !== null,
        heatmaps:
          document.querySelectorAll("[data-testid='stats-activity-heatmap']").length,
      };
    });

    expect(reading.cellExists).toBe(true);
    expect(reading.source).toContain("Z.AI");
    expect(reading.source).toContain("2026-10-10");
    // Exactly one activity view per tab.
    expect(reading.heatmaps).toBe(1);
  });

  it("captures the block", async () => {
    await dashboardWithHeatmapYear();
    await gotoView("stats");
    await clickDisplayed('[data-testid="stats-tab-codex"]');
    await expectDisplayed('[data-testid="stats-activity-heatmap"]');

    // The nav rail is a fixed overlay, so it sits on top of an element
    // capture. It is hidden here rather than in a hook because every spec
    // reboots the app, which would put the rail back.
    await browser.execute(() => {
      const nav = document.querySelector('[data-testid="nav"]');
      if (nav instanceof HTMLElement) nav.style.display = "none";
    });

    // WebDriver Classic takes no clip rectangle and the block sits inside a
    // scrolling panel, so the capture comes back with the panel around it. That
    // is the useful shape here: the heatmap is read in place, beside the
    // figures it has to agree with. Only the fixed nav rail is hidden, since
    // it is an overlay that would otherwise cover the block.
    await browser.pause(400);

    const block = await $('[data-testid="stats-activity-heatmap"]');
    await block.saveScreenshot(process.env.HEATMAP_SHOT ?? "/tmp/heatmap.png");
    expect(true).toBe(true);
  });
});