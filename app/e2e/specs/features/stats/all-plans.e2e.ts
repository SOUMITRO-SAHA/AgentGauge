import { expect, browser } from "@wdio/globals";

import {
  dispatchCalls,
  statsWithZaiAnalytics,
  expectDisplayed,
  clearSeededStores,
} from "../../fixtures.js";

after(() => {
  clearSeededStores();
});

describe("Stats All plans", () => {
  it("shows each plan's own figures without visiting unrelated destinations", async () => {
    const initialRoute = await statsWithZaiAnalytics();
    expect(initialRoute).toBe("home");

    await expectDisplayed('[data-testid="stats-all-plans"]');
    await expectDisplayed('[data-testid="stats-plan-row-codex"]');
    await expectDisplayed('[data-testid="stats-plan-row-zai"]');

    const overview = await browser.execute(() => {
      const read = (id: string) =>
        document
          .querySelector(`[data-testid="${id}"]`)
          ?.textContent?.replace(/\s+/g, " ") ?? "";
      return {
        codexSource: read("stats-plan-row-codex-source"),
        codexCost: read("stats-plan-row-codex-cost"),
        zaiSource: read("stats-plan-row-zai-source"),
        zaiCost: read("stats-plan-row-zai-cost"),
        zaiBasis: read("stats-plan-row-zai-cost-basis"),
        codexBasis: read("stats-plan-row-codex-cost-basis"),
        codexRequests: read("stats-plan-row-codex-requests"),
        zaiRequests: read("stats-plan-row-zai-requests"),
        zaiPeak: read("stats-plan-row-zai-peak"),
        note: read("stats-all-plans-not-summed"),
        totalExists:
          document.querySelector('[data-testid="stats-all-plans-total"]') !==
          null,
      };
    });

    expect(overview.codexSource).toContain("local sessions");
    expect(overview.codexCost).toContain("$");
    expect(overview.zaiSource).toContain("30 days");
    expect(overview.zaiCost).not.toBe("—");
    expect(overview.zaiCost).toContain("$");
    expect(overview.zaiBasis).toContain("price list");
    expect(overview.zaiBasis).toContain("80% input / 20% output");
    expect(overview.zaiBasis).toContain("2026-10-11");
    expect(overview.codexBasis).toContain("not a bill");
    expect(overview.codexBasis).toContain("2026-10-11");
    expect(overview.codexBasis).toContain("1.1M tokens remain unpriced");
    expect(overview.codexRequests.replace(/\D/g, "")).toBe("2236");
    expect(overview.zaiRequests).toContain("requests");
    expect(overview.zaiPeak).toContain("peak");
    expect(overview.zaiPeak).toContain("2026-10-08");
    expect(overview.totalExists).toBe(false);
    expect(overview.note).toContain("summed");

    const visitedRoutes = (await dispatchCalls())
      .filter((call) => call.type === "setUiState")
      .map((call) => call.lastRoute);
    expect(visitedRoutes).toContain("stats");
    expect(visitedRoutes.filter((route) => route !== "stats")).toEqual([]);
  });
});
