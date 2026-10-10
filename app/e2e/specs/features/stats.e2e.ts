import { expect, browser, $, $$ } from "@wdio/globals";

import {
  clickDisplayed,
  dashboardLive,
  dispatchCalls,
  expectDisplayed,
  gotoView,
  restoreOnboardingStore,
} from "../fixtures.js";

/**
 * The Stats view: local analytics consent, and the activity and streaks that
 * appear once it is granted.
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
  beforeEach(async () => {
    await dashboardLive();
  });

  it("renders analytics only, with no quota windows", async () => {
    await gotoView("stats");
    await expectDisplayed('[data-testid="stats-analytics-consent"]');
    expect((await $$('[data-testid="stats-panel"]')).length).toBe(0);
    expect((await $$('[data-testid="stats-provenance"]')).length).toBe(0);
  });

  it("requires local analytics consent and renders Codex activity and streaks", async () => {
    await gotoView("stats");
    await expectDisplayed('[data-testid="stats-analytics-consent"]');
    expect(
      (await dispatchCalls()).some(
        (request) => request.type === "readAccountUsage",
      ),
    ).toBe(false);

    await clickDisplayed('[data-testid="stats-enable-analytics"]');
    await expectDisplayed('[data-testid="stats-account-analytics"]');
    await expectDisplayed('[data-testid="stats-daily-chart"]');
    await expectDisplayed('[data-testid="stats-current-streak"]');
    await expectDisplayed('[data-testid="stats-longest-streak"]');
    await expectDisplayed('[data-testid="stats-activity-coverage"]');

    const values = await browser.execute(() => ({
      lifetime: document.querySelector('[data-testid="stats-lifetime-tokens"]')
        ?.textContent,
      streak: document.querySelector('[data-testid="stats-current-streak"]')
        ?.textContent,
      historyReads:
        (
          window as unknown as { __ismMockCalls__?: Array<{ type?: string }> }
        ).__ismMockCalls__?.filter(
          (request) => request.type === "readAccountUsage",
        ).length ?? 0,
    }));
    expect(values.lifetime?.replace(/\D/g, "")).toBe("1234567");
    expect(values.streak).toBe("8 days");
    expect(values.historyReads).toBeGreaterThan(0);
    await expectDisplayed('[data-testid="stats-analytics-source"]');

    await clickDisplayed('[data-testid="stats-disable-analytics"]');
    await expectDisplayed('[data-testid="stats-analytics-consent"]');
    expect(
      await $('[data-testid="stats-account-analytics"]').isDisplayed(),
    ).toBe(false);
  });
});
