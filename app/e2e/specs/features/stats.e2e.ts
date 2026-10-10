import { expect, browser, $, $$ } from "@wdio/globals";

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
 * The Stats view: local analytics that is simply on, one tab per connected
 * plan, and the opt-out that stays a preference rather than a permission.
 *
 * Runs in the single ordered group configured in `wdio.conf.ts`; the harness
 * rules that make that work live in `../fixtures.ts`. The persisted stores are
 * restored at *file* scope, which is the only place mocha runs an `after`
 * after every `describe` here has finished.
 */
after(() => {
  restoreOnboardingStore();
});

describe("stats", () => {
  it("renders Codex analytics without asking, because analytics defaults on", async () => {
    await dashboardLive();
    await gotoView("stats");

    await expectDisplayed('[data-testid="stats-account-analytics"]');
    expect(
      (await $$('[data-testid="stats-analytics-consent"]')).length,
    ).toBe(0);
    expect(
      await $('[data-testid="stats-analytics-off"]').isExisting(),
    ).toBe(false);

    const values = await browser.execute(() => ({
      lifetime: document.querySelector('[data-testid="stats-lifetime-tokens"]')
        ?.textContent,
      historyReads:
        (
          window as unknown as { __ismMockCalls__?: Array<{ type?: string }> }
        ).__ismMockCalls__?.filter(
          (request) => request.type === "readAccountUsage",
        ).length ?? 0,
    }));
    expect(values.historyReads).toBeGreaterThan(0);
    expect(values.lifetime?.replace(/\D/g, "")).toBe("1234567");
    await expectDisplayed('[data-testid="stats-daily-chart"]');
    await expectDisplayed('[data-testid="stats-current-streak"]');
    await expectDisplayed('[data-testid="stats-analytics-source"]');
  });

  it("gives every connected plan a tab and shows its stats there", async () => {
    await dashboardWithPlans();
    await gotoView("stats");

    await expectDisplayed('[data-testid="stats-tab-codex"]');
    await expectDisplayed('[data-testid="stats-tab-zai"]');
    await expectDisplayed('[data-testid="stats-tab-alibaba-coding-plan"]');

    await clickDisplayed('[data-testid="stats-tab-zai"]');
    await expectDisplayed('[data-testid="stats-plan-reading"]');
    const zai = await browser.execute(() => ({
      plan: document.querySelector('[data-testid="stats-plan-name"]')
        ?.textContent,
      fiveHour: document.querySelector(
        '[data-testid="stats-plan-window-used-5h"]',
      )?.textContent,
    }));
    expect(zai.plan).toBe("Pro");
    expect(zai.fiveHour).toContain("16% used");
    await expectDisplayed('[data-testid="stats-plan-source"]');

    await clickDisplayed('[data-testid="stats-tab-alibaba-coding-plan"]');
    await expectDisplayed('[data-testid="stats-plan-unreadable"]');
  });

  it("turns local analytics off and back on as a preference, with no gate", async () => {
    await dashboardLive();
    await gotoView("stats");

    await expectDisplayed('[data-testid="stats-account-analytics"]');
    await clickDisplayed('[data-testid="stats-disable-analytics"]');
    await expectDisplayed('[data-testid="stats-analytics-off"]');
    expect(
      await $('[data-testid="stats-account-analytics"]').isExisting(),
    ).toBe(false);

    await clickDisplayed('[data-testid="stats-enable-analytics"]');
    await expectDisplayed('[data-testid="stats-account-analytics"]');
  });
});
