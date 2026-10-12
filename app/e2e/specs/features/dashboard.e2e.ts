import { expect, browser, $ } from "@wdio/globals";

import {
  dashboardLive,
  dashboardUnavailable,
  expectDisplayed,
  gotoView,
  clearSeededStores,
} from "../fixtures.js";

/**
 * Home-view coverage: the usage reading, the plan and freshness that
 * accompany it, and the explicit states that replace it when nothing can be
 * read.
 *
 * Runs in the single ordered group configured in `wdio.conf.ts`; the harness
 * rules that make that work live in `../fixtures.ts`. The persisted stores are
 * restored at *file* scope, which is the only place mocha runs an `after`
 * after every `describe` here has finished.
 */
after(() => {
  clearSeededStores();
});

describe("dashboard", () => {
  beforeEach(async () => {
    await dashboardLive();
  });

  it("shows the shell once onboarding is dismissed", async () => {
    await expectDisplayed('[data-testid="app-shell"]');
    // The reverse flag is ignored by this wdio build; assert absence directly.
    expect(await $('[data-testid="onboarding"]').isDisplayed()).toBe(false);
  });

  it("keeps the Home header and panels separated by the container gap", async () => {
    for (const view of ["home", "stats", "automation", "processes", "settings"] as const) {
      await gotoView(view);
      const rowGap = await browser.execute((route) => {
        const container = document.querySelector(`[data-testid="view-${route}"]`);
        return container ? Number.parseFloat(getComputedStyle(container).rowGap) : null;
      }, view);

      expect(rowGap).toBe(16);

      if (view === "processes") {
        await expectDisplayed('[data-testid="process-panel-codex"]');
        expect(await $('[data-testid="process-loading-skeleton"]').isExisting()).toBe(
          false,
        );
      }
    }

    await gotoView("home");
    const panelGap = await browser.execute(() => {
      const detection = document.querySelector('[data-testid="provider-status"]');
      const usage = document.querySelector('[data-testid="usage-panel"]');
      if (!detection || !usage) return null;
      return usage.getBoundingClientRect().top - detection.getBoundingClientRect().bottom;
    });

    expect(panelGap).not.toBeNull();
    expect(panelGap).toBeGreaterThanOrEqual(16);
  });

  it("renders the plan and freshness alongside the number", async () => {
    await expect($('[data-testid="plan"]')).toHaveText("Team");
    await expect($('[data-testid="freshness-pill"]')).toHaveAttribute(
      "data-freshness",
      "live",
    );
    expect(await $('[data-testid="status-loading"]').isExisting()).toBe(false);
    await expect($('[data-testid="home-watcher"]')).toHaveText(
      "1 rollover monitor is running.",
    );
    expect(await $('[data-testid="home-watcher-loading"]').isExisting()).toBe(
      false,
    );
  });

  it("renders both the 5-hour and weekly windows", async () => {
    const bars = await $$('[data-testid="window-bar"]');
    expect(bars).toHaveLength(2);
    expect(await $('[data-testid="window-skeleton"]').isExisting()).toBe(false);
    await expect($('[data-testid="usage-panel"]')).toHaveText(
      expect.stringContaining("5-hour window"),
    );
    await expect($('[data-testid="usage-panel"]')).toHaveText(
      expect.stringContaining("Weekly limit"),
    );
  });

  it("shows remaining, not used, so the bar cannot be read backwards", async () => {
    await expect($('[data-testid="usage-panel"]')).toHaveText(
      expect.stringContaining("88% left"),
    );
    await expect($('[data-testid="usage-panel"]')).toHaveText(
      expect.stringContaining("12% used"),
    );
  });

  it("shows a reset countdown rather than a bare timestamp", async () => {
    await expect($('[data-testid="window-reset"]')).toHaveText(
      expect.stringContaining("Resets in"),
    );
  });
});

describe("dashboard when Codex is unavailable", () => {
  beforeEach(async () => {
    await dashboardUnavailable();
  });

  it("renders an explicit unavailable state, never a zero", async () => {
    await expectDisplayed('[data-testid="window-unavailable"]');
    await expect($('[data-testid="window-unavailable"]')).toHaveText(
      expect.stringContaining("codex login"),
    );
  });

  it("does not render any usage bar when there is no reading", async () => {
    const bars = await $$('[data-testid="window-bar"]');
    expect(bars).toHaveLength(0);
  });

  it("marks the freshness pill as unavailable", async () => {
    await expect($('[data-testid="freshness-pill"]')).toHaveText("Unavailable");
  });

  it("tells the user how to install Codex", async () => {
    await expect($('[data-testid="provider-status"]')).toHaveText(
      expect.stringContaining("npm install -g @openai/codex"),
    );
  });
});
