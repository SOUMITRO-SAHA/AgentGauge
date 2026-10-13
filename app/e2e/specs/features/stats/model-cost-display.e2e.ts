import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { browser, expect } from "@wdio/globals";

import {
  clearSeededStores,
  clickDisplayed,
  dashboardLive,
  dashboardWithZaiAnalytics,
  expectDisplayed,
  gotoView,
} from "../../fixtures.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);

after(() => {
  clearSeededStores();
});

describe("Stats model cost display", () => {
  it("keeps Codex model estimates and removes the estimated-cost share row", async () => {
    await dashboardLive();
    expect((await browser.getUrl()).startsWith("tauri://localhost")).toBe(true);
    await gotoView("stats");
    await clickDisplayed('[data-testid="stats-tab-codex"]');
    await expectDisplayed('[data-testid="stats-local-logs"]');
    await browser.execute(() => {
      document
        .querySelector('[data-testid="stats-projects"]')
        ?.scrollIntoView({ block: "center" });
    });
    const screenshotDir = path.join(repoRoot, ".temp", "screenshots");
    fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshotPath = path.join(
      screenshotDir,
      "stats-project-leaderboard.png",
    );
    await browser.saveScreenshot(screenshotPath);
    expect(fs.statSync(screenshotPath).size).toBeGreaterThan(1000);

    const view = await browser.execute(() => ({
      rows: Array.from(
        document.querySelectorAll('[data-testid^="stats-local-model-"]'),
      ).map((row) => row.textContent ?? ""),
      projects: Array.from(
        document.querySelectorAll('[data-testid="stats-project-row"]'),
      ).map((row) => ({
        text: row.textContent ?? "",
        rank:
          row.querySelector('[data-testid="stats-project-rank"]')
            ?.textContent ?? "",
        details:
          row.querySelector('[data-testid="stats-project-details"]')
            ?.textContent ?? "",
        progressValue:
          row.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow") ??
          null,
      })),
      source:
        document.querySelector('[data-testid="stats-local-source"]')
          ?.textContent ?? "",
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));

    expect(view.rows.length).toBeGreaterThan(0);
    expect(view.rows[0]).toContain("≈ $");
    expect(view.rows.every((row) => !row.includes("% of est. cost"))).toBe(true);
    expect(view.projects.length).toBeGreaterThan(0);
    expect(view.projects[0]?.rank).toBe("01");
    expect(view.projects[0]?.text).toContain("API estimate");
    expect(view.projects[0]?.text).toContain("≈ $");
    expect(view.projects[0]?.details).toContain("responses");
    expect(view.projects[0]?.progressValue).not.toBeNull();
    expect(view.projects.some((row) => row.text.includes("Not priced"))).toBe(
      true,
    );
    expect(
      view.projects.every((row) => !row.text.includes("% of est. cost")),
    ).toBe(true);
    expect(view.source).toContain("USD per 1M tokens");
    expect(view.documentWidth).toBeLessThanOrEqual(view.viewportWidth);
  });

  it("labels reference API rates and omits cost-share bars from provider rows", async () => {
    await dashboardWithZaiAnalytics();
    await gotoView("stats");
    await clickDisplayed('[data-testid="stats-tab-zai"]');
    await expectDisplayed('[data-testid="stats-model-mix"]');

    const view = await browser.execute(() => ({
      rows: Array.from(
        document.querySelectorAll('[data-testid^="stats-model-row-"]'),
      ).map((row) => row.textContent ?? ""),
      source:
        document.querySelector('[data-testid="stats-model-mix-source"]')
          ?.textContent ?? "",
    }));

    expect(view.rows.length).toBeGreaterThan(0);
    expect(view.rows[0]).toContain("≈ $");
    expect(view.rows.every((row) => !row.includes("% of est. cost"))).toBe(true);
    expect(view.source).toContain("USD per 1M tokens");
    expect(view.source).toContain("80% input");
    expect(view.source).toContain("20% output");
    expect(view.source).toContain("not a bill");
  });
});
