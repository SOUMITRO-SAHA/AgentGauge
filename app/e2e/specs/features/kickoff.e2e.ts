import { expect } from "@wdio/globals";

import {
  clickDisplayed,
  dashboardWithPlans,
  dispatchCalls,
  expectDisplayed,
  gotoView,
  restoreOnboardingStore,
} from "../fixtures.js";

/**
 * The scheduled kickoff: an explicit opt-in per connected sub, a model picker
 * that names the cheapest tier, a countdown to the next auto "Hi", and the
 * honest note that the background scheduler is not running when it is not.
 *
 * The fixture boots with the scheduler supported but not installed and every
 * sub opted out — the app's real default — so the specs exercise exactly the
 * path a first-time user sees. Writes are asserted through the recorded
 * dispatch calls, because the schedule file belongs to the backend, not the
 * renderer.
 *
 * Runs in the single ordered group configured in `wdio.conf.ts`.
 */
after(() => {
  restoreOnboardingStore();
});

async function bootOnHome(): Promise<void> {
  await dashboardWithPlans();
  await gotoView("home");
  await clickDisplayed('[data-testid="refresh-usage"]');
}

describe("scheduled kickoff", () => {
  it("starts opted out for every sub: a toggle that is off and no schedule", async () => {
    await bootOnHome();

    const toggle = await $('[data-testid="kickoff-toggle"]');
    expect(await toggle.getAttribute("aria-checked")).toBe("false");
    expect(await $('[data-testid="kickoff-next"]')).not.toExist();
  });

  it("opting in reveals the model picker, the countdown, and records the choice", async () => {
    await bootOnHome();

    await clickDisplayed('[data-testid="kickoff-toggle"]');

    await expectDisplayed('[data-testid="kickoff-next"]');
    await expect($('[data-testid="kickoff-next"]')).toHaveText(
      expect.stringContaining("in 1h"),
    );
    await expect($('[data-testid="kickoff-model"]')).toHaveText(
      expect.stringContaining("GPT-6 Luna"),
    );

    const calls = await dispatchCalls();
    const enables = calls.filter(
      (request) =>
        request.type === "setKickoffEnabled" &&
        request.kind === "codex" &&
        request.enabled === true,
    );
    expect(enables.length).toBeGreaterThanOrEqual(1);
  });

  it("offers the model catalog with the cheapest tier marked and records the pick", async () => {
    await bootOnHome();
    await clickDisplayed('[data-testid="kickoff-toggle"]');
    await expectDisplayed('[data-testid="kickoff-next"]');

    await clickDisplayed('[data-testid="kickoff-model"]');
    await browser.pause(500);

    // The open listbox is visible to the page (probed: visibility visible,
    // real rects) but the WebDriver isDisplayed atom answers false for the
    // portal-mounted options on this WKWebView build — the same
    // driver-world/app-world split recorded for Radix tabs. Assert the
    // catalog through the page, then pick with the keyboard: the highlighted
    // entry is the selected one, and Enter confirms it.
    const catalog = await browser.execute(() => {
      const options = Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-testid^='kickoff-model-option']",
        ),
      );
      return {
        count: options.length,
        ids: options.map((option) => option.getAttribute("data-testid")),
        cheapestLabel:
          options
            .find((option) => option.getAttribute("data-testid") === "kickoff-model-option-gpt-6-luna")
            ?.textContent ?? null,
      };
    });
    expect(catalog.count).toBeGreaterThanOrEqual(2);
    expect(catalog.ids).toContain("kickoff-model-option-gpt-6.1-sol");
    expect(catalog.cheapestLabel).toContain("cheapest");

    // Enter on the already-selected entry would be a no-op (Radix only fires
    // on a value change), so move the highlight up to a different model and
    // confirm that one.
    await browser.keys("ArrowUp");
    await browser.keys("Enter");

    const calls = await dispatchCalls();
    const picks = calls.filter(
      (request) =>
        request.type === "setKickoffModel" &&
        request.kind === "codex" &&
        request.modelId === "gpt-6.1-sol",
    );
    expect(picks.length).toBeGreaterThanOrEqual(1);
  });

  it("warns honestly when the background scheduler is not installed", async () => {
    await dashboardWithPlans();
    await gotoView("home");
    await clickDisplayed('[data-testid="refresh-usage"]');

    await clickDisplayed('[data-testid="kickoff-toggle"]');

    await expectDisplayed('[data-testid="kickoff-scheduler-warn"]');
    const warning = await $('[data-testid="kickoff-scheduler-warn"]');
    expect(await warning.getText()).toContain("not installed");
  });
});
