import { expect } from "@wdio/globals";

import {
  clickDisplayed,
  dashboardLive,
  dashboardWithPlans,
  dispatchCalls,
  expectDisplayed,
  gotoView,
  restoreOnboardingStore,
} from "../fixtures.js";

/**
 * The Usage tab row: Codex always present, one tab per connected coding plan,
 * a switch that fetches the selected provider, and an honest "cannot read"
 * state for a connected plan with no reader.
 *
 * Every case re-reads through the refresh control before asserting: the tab
 * set must reflect what OpenCode reports *now*, never whichever read —
 * mount-time or refreshed, real or mocked — happened to answer first. That is
 * the whole point of the feature: only connected providers appear.
 *
 * Runs in the single ordered group configured in `wdio.conf.ts`; the harness
 * rules that make that work live in `../fixtures.ts`.
 */
after(() => {
  restoreOnboardingStore();
});

/** Boots onto Home and re-reads, so the fixture's provider set is what shows. */
async function bootOnHome(
  boot: () => Promise<void>,
): Promise<void> {
  await boot();
  await gotoView("home");
  await clickDisplayed('[data-testid="refresh-usage"]');
}

describe("usage tabs", () => {
  it("shows only Codex when no other plan is connected", async () => {
    await bootOnHome(dashboardLive);

    await expectDisplayed('[data-testid="usage-tab-codex"]');
    const tabs = await $$('[data-testid^="usage-tab-"]');
    expect(tabs).toHaveLength(1);
    expect(await tabs[0].getText()).toBe("Codex");
  });

  it("shows a tab per connected plan beside Codex", async () => {
    await bootOnHome(dashboardWithPlans);

    await expectDisplayed('[data-testid="usage-tab-codex"]');
    await expectDisplayed('[data-testid="usage-tab-zai"]');
    await expectDisplayed('[data-testid="usage-tab-alibaba-coding-plan"]');

    const labels = await $$('[data-testid^="usage-tab-"]').map((tab) =>
      tab.getText(),
    );
    expect(labels).toEqual(["Codex", "Z.AI", "Alibaba Coding Plan"]);
  });

  it("reads Codex by default and fetches the plan on switch", async () => {
    await bootOnHome(dashboardWithPlans);

    await expect($('[data-testid="plan"]')).toHaveText("Team");
    await expect($('[data-testid="home-remaining"]')).toHaveText(
      expect.stringContaining("88"),
    );

    await clickDisplayed('[data-testid="usage-tab-zai"]');

    await expect($('[data-testid="plan"]')).toHaveText("Pro");
    await expect($('[data-testid="home-remaining"]')).toHaveText(
      expect.stringContaining("84"),
    );

    const zaiReads = (await dispatchCalls()).filter(
      (request) =>
        request.type === "readUsageFor" && request.provider === "zai",
    );
    expect(zaiReads.length).toBeGreaterThanOrEqual(1);
  });

  it("switching back to Codex re-reads Codex", async () => {
    await bootOnHome(dashboardWithPlans);

    await clickDisplayed('[data-testid="usage-tab-zai"]');
    await expect($('[data-testid="plan"]')).toHaveText("Pro");

    await clickDisplayed('[data-testid="usage-tab-codex"]');
    await expect($('[data-testid="plan"]')).toHaveText("Team");
  });

  it("says when a connected plan cannot be read rather than inventing numbers", async () => {
    await bootOnHome(dashboardWithPlans);

    await clickDisplayed('[data-testid="usage-tab-alibaba-coding-plan"]');

    await expectDisplayed('[data-testid="usage-plan-unreadable"]');
    const remaining = await $$('[data-testid="home-remaining"]');
    expect(remaining).toHaveLength(0);
  });
});
