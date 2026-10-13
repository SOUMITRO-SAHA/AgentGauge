import { expect, browser } from "@wdio/globals";

import {
  clearSeededStores,
  clickDisplayed,
  expectDisplayed,
  statsWithCodexLocalAnalytics,
} from "../../fixtures.js";

after(() => {
  clearSeededStores();
});

describe("stats local session analytics", () => {
  it("shows daily sessions, session statistics, and weekly model share", async () => {
    await statsWithCodexLocalAnalytics();
    await clickDisplayed('[data-testid="stats-tab-codex"]');
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            document
              .querySelector('[data-testid="stats-tab-codex"]')
              ?.getAttribute("data-active") === "true",
        )) === true,
      { timeout: 8000, timeoutMsg: "Codex Stats tab did not become active" },
    );

    await expectDisplayed('[data-testid="stats-local-session-stats"]');
    await expectDisplayed('[data-testid="stats-local-session-chart"]');
    await expectDisplayed('[data-testid="stats-model-timeline"]');

    await browser.waitUntil(
      async () =>
        (await browser.execute(() => {
          const timeline = document.querySelector(
            '[data-testid="stats-model-timeline"]',
          );
          return (
            timeline?.textContent?.includes("GPT-5.5") === true &&
            timeline.textContent.includes("GPT-6 Luna")
          );
        })) === true,
      { timeout: 8000, timeoutMsg: "Model timeline labels did not render" },
    );

    const rendered = await browser.execute(() => {
      const timeline = document.querySelector(
        '[data-testid="stats-model-timeline"]',
      );
      const chart = timeline?.querySelector('[data-slot="chart"]');
      const svg = chart?.querySelector("svg");
      const sessionBars = Array.from(
        document.querySelectorAll(
          '[data-testid="stats-local-session-chart"] .recharts-rectangle',
        ),
      )
        .map((bar) => ({
          x: Number(bar.getAttribute("x")),
          width: Number(bar.getAttribute("width")),
          height: Number(bar.getAttribute("height")),
        }))
        .filter((bar) => bar.width > 0 && bar.height > 0)
        .sort((left, right) => left.x - right.x);
      const modelBars = Array.from(
        svg?.querySelectorAll(".recharts-rectangle") ?? [],
      )
        .map((bar) => ({
          x: bar.getAttribute("x"),
          width: Number(bar.getAttribute("width")),
          height: Number(bar.getAttribute("height")),
        }))
        .filter((bar) => bar.width > 0 && bar.height > 0);
      const barsPerX = new Map<string, number>();
      for (const bar of modelBars) {
        const x = bar.x ?? "";
        barsPerX.set(x, (barsPerX.get(x) ?? 0) + 1);
      }
      const sessionCenter = (bar: (typeof sessionBars)[number]) =>
        bar.x + bar.width / 2;
      return {
        median: document.querySelector(
          '[data-testid="stats-local-median-session"]',
        )?.textContent,
        compactions: document.querySelector(
          '[data-testid="stats-local-compactions"]',
        )?.textContent,
        sessionNote: document.querySelector(
          '[data-testid="stats-local-session-chart"] p',
        )?.textContent,
        modelText: timeline?.textContent,
        chartLabel: chart?.getAttribute("aria-label"),
        barSegments: Array.from(
          svg?.querySelectorAll(".recharts-rectangle") ?? [],
        ).filter(
          (segment) =>
            Number(segment.getAttribute("width")) > 0 &&
            Number(segment.getAttribute("height")) > 0,
        ).length,
        stackedSegments: Math.max(0, ...barsPerX.values()),
        sessionGapRatio:
          (sessionCenter(sessionBars[2]!) - sessionCenter(sessionBars[1]!)) /
          (sessionCenter(sessionBars[1]!) - sessionCenter(sessionBars[0]!)),
      };
    });

    expect(rendered.median).toMatch(/1[.,]25M/);
    expect(rendered.compactions).toContain("6");
    expect(rendered.sessionNote).toContain("remain blank, not zero");
    expect(rendered.modelText).toContain("GPT-5.5");
    expect(rendered.modelText).toContain("GPT-6 Luna");
    expect(rendered.modelText).toContain("gpt-5.5-preview");
    expect(rendered.chartLabel).toContain("Weekly model share of local tokens");
    expect(rendered.barSegments).toBeGreaterThan(0);
    expect(rendered.stackedSegments).toBeGreaterThanOrEqual(2);
    expect(rendered.sessionGapRatio).toBeGreaterThan(4);

    await clickDisplayed('[data-testid="stats-tab-all"]');
  });
});
