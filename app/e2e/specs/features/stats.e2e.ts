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
    // The token count opens compact; clicking pins the exact number.
    expect(/1[.,]23M/.test(values.total ?? "")).toBe(true);
    await clickDisplayed('[data-testid="stats-total-tokens"]');
    const exact = await browser.execute(
      () =>
        document.querySelector('[data-testid="stats-total-tokens"]')
          ?.textContent,
    );
    expect(exact?.replace(/\D/g, "")).toBe("1234567");
    await expectDisplayed('[data-testid="stats-daily-chart"]');
    await expectDisplayed('[data-testid="stats-current-streak"]');
    await expectDisplayed('[data-testid="stats-analytics-source"]');

    // The window reading rides below the analytics, exactly like the other
    // token-history tabs: the chart answers what the tokens did, the windows
    // answer how full the plan is.
    await expectDisplayed('[data-testid="stats-plan-reading"]');
    const reading = await browser.execute(() => ({
      plan: document.querySelector('[data-testid="stats-plan-name"]')
        ?.textContent,
      fiveHour: document.querySelector(
        '[data-testid="stats-plan-window-used-5h"]',
      )?.textContent,
      source: document.querySelector('[data-testid="stats-plan-source"]')
        ?.textContent,
    }));
    expect(reading.plan).toBeTruthy();
    expect(reading.fiveHour).toContain("used");
    expect(reading.source).toContain("app-server");
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

    // Hovering a bar raises the tooltip: exact number first, the compact form
    // in brackets beside it, on a properly spaced row.
    let tooltip: { text: string; gap: string } | null = null;
    const readTooltip = () =>
      browser.execute(() => {
        const row = document.querySelector(
          ".recharts-tooltip-wrapper .gap-2",
        );
        if (!row) return null;
        return {
          text: row.textContent ?? "",
          gap: getComputedStyle(row).columnGap,
        };
      });
    for (const fraction of [0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85]) {
      await browser.execute((fx) => {
        const chart = document.querySelector<HTMLElement>(
          '[data-testid="stats-daily-chart"]',
        );
        if (!chart) return;
        // Recharts binds its mousemove handler on the wrapper *inside* this
        // container, so the event must be dispatched on a descendant — the
        // chart surface — and bubble up through it.
        const surface = chart.querySelector("svg") ?? chart;
        const rect = surface.getBoundingClientRect();
        surface.dispatchEvent(
          new MouseEvent("mousemove", {
            bubbles: true,
            clientX: rect.x + rect.width * (fx as number),
            clientY: rect.y + rect.height * 0.85,
          }),
        );
      }, fraction);
      await browser.pause(200);
      tooltip = await readTooltip();
      if (tooltip) break;
    }
    if (!tooltip) {
      const rect = await browser.execute(() => {
        const box = document
          .querySelector('[data-testid="stats-daily-chart"]')
          ?.getBoundingClientRect();
        return box
          ? { x: box.x, y: box.y, width: box.width, height: box.height }
          : null;
      });
      if (rect) {
        for (const fraction of [0.3, 0.45, 0.6, 0.75]) {
          await browser.performActions([
            {
              type: "pointer",
              id: "stats-tooltip-pointer",
              parameters: { pointerType: "mouse" },
              actions: [
                {
                  type: "pointerMove",
                  duration: 0,
                  x: Math.round(rect.x + rect.width * fraction),
                  y: Math.round(rect.y + rect.height * 0.85),
                },
              ],
            },
          ]);
          await browser.pause(250);
          tooltip = await readTooltip();
          if (tooltip) break;
        }
        await browser.releaseActions();
      }
    }
    expect(tooltip).not.toBeNull();
    expect(/\(\d+[.,]\d+[MB]\)/.test(tooltip?.text ?? "")).toBe(true);
    expect(Number.parseFloat(tooltip?.gap ?? "0")).toBeGreaterThan(4);

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
    expect(analytics.tokens ? /21[.,]7B/.test(analytics.tokens) : false).toBe(
      true,
    );
    expect(analytics.calls?.replace(/\D/g, "")).toBe("10419");
    // Clicking the token count pins the exact number, this card only.
    await clickDisplayed('[data-testid="stats-total-tokens"]');
    const pinned = await browser.execute(
      () =>
        document.querySelector('[data-testid="stats-total-tokens"]')
          ?.textContent,
    );
    expect(pinned?.replace(/\D/g, "")).toBe("21700000000");
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
