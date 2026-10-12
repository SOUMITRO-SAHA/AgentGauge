import { browser, expect } from "@wdio/globals";

import {
  clickDisplayed,
  dashboardWithHeatmapYear,
  dashboardWithPlans,
  expectDisplayed,
  gotoView,
} from "../../fixtures.js";

/**
 * The stats screen at narrow widths.
 *
 * Every panel here is optional content that must give way rather than push the
 * window sideways, so the assertions are about overflow rather than about any
 * one panel's layout.
 */
describe("responsive stats", () => {
  const NARROW = 380;
  const WIDE = 900;

  /**
   * Anything sticking out past the viewport, and anything scrolling sideways
   * inside itself.
   *
   * Only *leaf* offenders are reported: when a container overflows, every one
   * of its ancestors does too, and naming the outermost tells you nothing about
   * what to change. The leaf is the thing with a fixed width or a missing
   * `min-w-0`.
   */
  const overflowReport = () =>
    browser.execute(() => {
      const root = document.documentElement;
      const limit = root.clientWidth;
      const all = Array.from(document.querySelectorAll("*"));
      const past = (node: Element) => node.getBoundingClientRect().right > limit + 1;

      const offenders: Array<Record<string, unknown>> = [];
      const scrollers: Array<Record<string, unknown>> = [];
      for (const node of all) {
        const box = node.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;

        if (past(node) && !Array.from(node.children).some(past)) {
          offenders.push({
            testid: node.getAttribute("data-testid") ?? "",
            cls: (node.getAttribute("class") ?? "").slice(0, 70),
            tag: node.tagName.toLowerCase(),
            right: Math.round(box.right),
            width: Math.round(box.width),
          });
        }

        if (node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0) {
          let depth = 0;
          for (let up = node; up !== null; up = up.parentElement) depth += 1;
          scrollers.push({
            testid: node.getAttribute("data-testid") ?? "",
            cls: (node.getAttribute("class") ?? "").slice(0, 70),
            depth,
            scrollWidth: node.scrollWidth,
            clientWidth: node.clientWidth,
          });
        }
      }
      return {
        viewport: limit,
        documentOverflow: root.scrollWidth - root.clientWidth,
        bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
        offenders: offenders.slice(0, 10),
        scrollers: scrollers.sort((a, b) => b.depth - a.depth).slice(0, 8),
      };
    });

  /**
   * The harness's `expect` takes a single argument, so a failure has to carry
   * its own diagnosis: naming the offending elements is the difference between
   * a red test and a fix.
   */
  const assertFits = (
    report: Awaited<ReturnType<typeof overflowReport>>,
    label: string,
  ) => {
    const overflow = Math.max(report.documentOverflow, report.bodyOverflow);
    if (overflow > 0) {
      throw new Error(
        `${label} overflows by ${overflow}px of ${report.viewport}px: ` +
          `leaves=${JSON.stringify(report.offenders)} ` +
          `scrollers=${JSON.stringify(report.scrollers)}`,
      );
    }
  };

  it("fits a narrow window on the local-reading tab", async () => {
    await dashboardWithHeatmapYear();
    await gotoView("stats");
    await clickDisplayed('[data-testid="stats-tab-codex"]');
    await expectDisplayed('[data-testid="stats-activity-heatmap"]');

    await browser.setWindowSize(NARROW, 800);
    await browser.pause(500);

    assertFits(await overflowReport(), "narrow local reading");

    // The activity grid shrinks with the panel rather than scrolling inside it,
    // so a narrow window shows fewer weeks at a readable cell size instead of
    // a full year the reader has to pan across.
    const grid = await browser.execute(() => {
      const node = document.querySelector('[data-testid="stats-activity-grid"]');
      const cells = node?.querySelectorAll("[data-testid^='stats-activity-cell-']");
      const first = cells?.[0]?.getBoundingClientRect();
      return {
        gridWidth: node?.getBoundingClientRect().width ?? 0,
        weeks: (cells?.length ?? 0) / 7,
        cellPx: first?.width ?? 0,
      };
    });
    expect(grid.gridWidth).toBeGreaterThan(0);
    expect(grid.weeks).toBeGreaterThan(0);
    expect(grid.weeks).toBeLessThan(53);
    // Cells stay big enough to read rather than shrinking into a grey smear.
    expect(grid.cellPx).toBeGreaterThanOrEqual(8);
  });

  it("fits a narrow window on the overview and the provider tabs", async () => {
    await dashboardWithPlans();
    await gotoView("stats");
    await expectDisplayed('[data-testid="stats-tab-codex"]');

    await browser.setWindowSize(NARROW, 800);
    await browser.pause(400);

    for (const tab of ["stats-tab-zai", "stats-tab-codex"]) {
      await clickDisplayed(`[data-testid="${tab}"]`);
      await browser.pause(500);
      assertFits(await overflowReport(), `narrow ${tab}`);
    }
  });

  it("fits a wide window too", async () => {
    await dashboardWithHeatmapYear();
    await gotoView("stats");
    await clickDisplayed('[data-testid="stats-tab-codex"]');
    await expectDisplayed('[data-testid="stats-activity-heatmap"]');

    await browser.setWindowSize(WIDE, 900);
    await browser.pause(400);

    assertFits(await overflowReport(), "wide local reading");

    // Responsive means the grid *uses* the room it is given rather than
    // sitting at a fixed width: it fills its frame, and its cells stay big
    // enough to read. How many weeks that buys depends on the panel, and the
    // caption says so.
    const grid = await browser.execute(() => {
      const node = document.querySelector('[data-testid="stats-activity-grid"]');
      const frame = node?.parentElement;
      const cell = node?.querySelector("[data-testid^='stats-activity-cell-']");
      return {
        gridWidth: node?.getBoundingClientRect().width ?? 0,
        frameWidth: frame?.getBoundingClientRect().width ?? 0,
        cellPx: cell?.getBoundingClientRect().width ?? 0,
      };
    });
    expect(grid.cellPx).toBeGreaterThanOrEqual(8);
    expect(grid.gridWidth).toBeGreaterThan(grid.frameWidth * 0.9);
  });
});