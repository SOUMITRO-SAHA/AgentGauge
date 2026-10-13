import { expect, browser, $$ } from "@wdio/globals";

import {
  clearSeededStores,
  clickDisplayed,
  dashboardWithStatsTrends,
  expectDisplayed,
  gotoView,
} from "../../fixtures.js";

after(() => {
  clearSeededStores();
});

describe("stats cost and trend charts", () => {
  it("renders a priced cost trajectory, break-even marker, and seven-day overlay", async () => {
    await dashboardWithStatsTrends();
    await gotoView("stats");
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            document
              .querySelector('[data-testid="nav-stats"]')
              ?.getAttribute("aria-current") === "page",
        )) === true,
      { timeout: 8000, timeoutMsg: "Stats view did not become active" },
    );
    await clickDisplayed('[data-testid="stats-tab-zai"]');

    await expectDisplayed('[data-testid="stats-cost-trajectory-chart"]');
    await expectDisplayed('[data-testid="stats-daily-chart"]');

    const rendered = await browser.execute(() => {
      const costChart = document.querySelector(
        '[data-testid="stats-cost-trajectory-chart"]',
      );
      const dailyChart = document.querySelector(
        '[data-testid="stats-daily-chart"]',
      );
      const tokenBars = Array.from(
        dailyChart?.querySelectorAll(".recharts-rectangle") ?? [],
      )
        .map((bar) => ({
          x: Number(bar.getAttribute("x")),
          width: Number(bar.getAttribute("width")),
          height: Number(bar.getAttribute("height")),
        }))
        .filter((bar) => bar.width > 0 && bar.height > 0)
        .sort((left, right) => left.x - right.x);
      const center = (bar: (typeof tokenBars)[number]) => bar.x + bar.width / 2;
      return {
        costLineCount:
          costChart?.querySelectorAll(".recharts-line-curve").length ?? 0,
        costReferenceCount:
          costChart?.querySelectorAll(".recharts-reference-line").length ?? 0,
        rollingLineCount:
          dailyChart?.querySelectorAll(".recharts-line-curve").length ?? 0,
        note: document.querySelector(
          '[data-testid="stats-cost-trajectory-summary"]',
        )?.textContent,
        rollingNote: document.querySelector(
          '[data-testid="stats-rolling-average-note"]',
        )?.textContent,
        costGapNote: document.querySelector(
          '[data-testid="stats-cost-trajectory-gap"]',
        )?.textContent,
        calendarGapRatio:
          (center(tokenBars[3]!) - center(tokenBars[2]!)) /
          (center(tokenBars[2]!) - center(tokenBars[1]!)),
      };
    });

    expect(rendered.costLineCount).toBeGreaterThan(0);
    expect(rendered.costReferenceCount).toBeGreaterThanOrEqual(2);
    expect(rendered.rollingLineCount).toBeGreaterThan(0);
    expect(rendered.calendarGapRatio).toBeGreaterThan(1.8);
    expect(rendered.note).toContain("Crossed the monthly plan price");
    expect(rendered.rollingNote).toContain("7-day average");
    expect(rendered.costGapNote).toContain("daily cost coverage is incomplete");
    expect(await $$('[data-testid="stats-cost-trajectory-gap"]')).toHaveLength(1);
    expect(await $$('[data-testid="stats-cost-trajectory-unavailable"]')).toHaveLength(0);

    await clickDisplayed('[data-testid="stats-tab-codex"]');
  });
});
