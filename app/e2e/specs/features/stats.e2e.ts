import { expect, browser, $, $$ } from "@wdio/globals";

import {
  dashboardLive,
  dashboardWithPlans,
  dashboardWithZaiAnalytics,
  dispatchCalls,
  clickDisplayed,
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
 *
 * Tab switches use `clickDisplayed` (the driver's native click): the
 * fixtures' trap notes that page-level DOM clicks do not reliably reach React
 * for Radix tabs, and the usage-tabs specs prove the native path.
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
      total: document.querySelector('[data-testid="stats-total-tokens"]')
        ?.textContent,
      historyReads:
        (
          window as unknown as { __ismMockCalls__?: Array<{ type?: string }> }
        ).__ismMockCalls__?.filter(
          (request) => request.type === "readAccountUsage",
        ).length ?? 0,
    }));
    expect(values.historyReads).toBeGreaterThan(0);
    expect(values.total?.replace(/\D/g, "")).toBe("1234567");
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

    // Leave the selection on Codex: the tab atom outlives this spec's boot in
    // the shared document, and a later boot mounting this tab's body would
    // read through the real backend before its mock is installed.
    await clickDisplayed('[data-testid="stats-tab-codex"]');
  });

  it("shows Z.AI token analytics like Codex's, labelled with its window", async () => {
    await dashboardWithZaiAnalytics();
    await gotoView("stats");

    await clickDisplayed('[data-testid="stats-tab-zai"]');
    await expectDisplayed('[data-testid="stats-plan-analytics"]');
    await expectDisplayed('[data-testid="stats-daily-chart"]');

    const analytics = await browser.execute(() => ({
      tokens: document.querySelector('[data-testid="stats-total-tokens"]')
        ?.textContent,
      calls: document.querySelector('[data-testid="stats-total-requests"]')
        ?.textContent,
      coverage: document.querySelector(
        '[data-testid="stats-activity-coverage"]',
      )?.textContent,
      reading: Array.from(
        document.querySelectorAll('[data-testid="stats-plan-reading"]'),
      ).some((el) => (el as HTMLElement).offsetParent !== null),
    }));
    expect(analytics.tokens?.replace(/\D/g, "")).toBe("21700000000");
    expect(analytics.calls?.replace(/\D/g, "")).toBe("10419");
    expect(analytics.coverage).toContain("2026-10-08");
    // The window reading stays on the tab beside the analytics.
    expect(analytics.reading).toBe(true);
    await expectDisplayed('[data-testid="stats-plan-analytics-source"]');

    await clickDisplayed('[data-testid="stats-tab-codex"]');
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
