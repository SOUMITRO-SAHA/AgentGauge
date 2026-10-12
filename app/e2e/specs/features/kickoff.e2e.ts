import { expect } from "@wdio/globals";

import {
  clickDisplayed,
  dashboardWithPlans,
  dispatchCalls,
  expectDisplayed,
  gotoView,
  clearSeededStores,
} from "../fixtures.js";

/**
 * The scheduled kickoff: an explicit opt-in per connected sub, a model picker
 * with a price-ranked default, a countdown to the next auto "Hi", and the
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
  clearSeededStores();
});

async function bootOnHome(): Promise<void> {
  await dashboardWithPlans();
  await gotoView("home");
  await clickDisplayed('[data-testid="refresh-usage"]');
}

async function bootOnAutomation(): Promise<void> {
  await dashboardWithPlans();
  await gotoView("automation");
}

describe("scheduled kickoff", () => {
  it("keeps kickoff controls off Home and groups them by sub in Automation", async () => {
    await bootOnHome();

    expect(
      await $$('#view-home [data-testid^="kickoff-section-"]'),
    ).toHaveLength(0);

    await gotoView("automation");
    await expectDisplayed('[data-testid="kickoff-section-codex"]');
    await expectDisplayed('[data-testid="kickoff-section-zai"]');
    await expect($('[data-testid="automation-panel-codex"] h2')).toHaveText(
      "Codex · Automation",
    );
    await expect($('[data-testid="automation-panel-zai"] h2')).toHaveText(
      "Z.AI · Automation",
    );
    await expectDisplayed('[data-testid="kickoff-model-codex"]');
    await expectDisplayed('[data-testid="kickoff-model-zai"]');
    await expect($('[data-testid="kickoff-toggle-codex"]')).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect($('[data-testid="kickoff-toggle-zai"]')).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(await $('[data-testid="kickoff-next-codex"]')).not.toExist();
    await expectDisplayed('[data-testid="kickoff-effort-codex"]');
  });

  it("enabling resets effort to minimum and locks configuration", async () => {
    await bootOnAutomation();

    await clickDisplayed('[data-testid="kickoff-effort-codex"]');
    await browser.keys("ArrowDown");
    await browser.keys("Enter");

    await clickDisplayed('[data-testid="kickoff-toggle-codex"]');

    await expectDisplayed('[data-testid="kickoff-next-codex"]');
    await expect($('[data-testid="kickoff-next-codex"]')).toHaveText(
      expect.stringContaining("in 1h"),
    );
    await expect($('[data-testid="kickoff-model-codex"]')).toHaveText(
      expect.stringContaining("GPT-6 Luna"),
    );
    await expect($('[data-testid="kickoff-effort-codex"]')).toHaveText(
      expect.stringContaining("Minimal"),
    );
    await expect($('[data-testid="kickoff-toggle-codex"]')).toHaveText("Stop");
    await expect($('[data-testid="kickoff-toggle-codex"]')).toHaveAttribute(
      "data-variant",
      "destructive",
    );
    await expect($('[data-testid="kickoff-model-codex"]')).toBeDisabled();
    await expect($('[data-testid="kickoff-effort-codex"]')).toBeDisabled();
    const lockExplanations = await browser.execute(() =>
      ["model", "effort"].map((control) =>
        document
          .querySelector<HTMLElement>(`[data-testid="kickoff-${control}-codex"]`)
          ?.parentElement?.getAttribute("title"),
      ),
    );
    expect(lockExplanations).toEqual([
      expect.stringContaining("Stop this kickoff before changing"),
      expect.stringContaining("Stop this kickoff before changing"),
    ]);

    const calls = await dispatchCalls();
    const enables = calls.filter(
      (request) =>
        request.type === "setKickoffEnabled" &&
        request.kind === "codex" &&
        request.enabled === true,
    );
    expect(enables.length).toBeGreaterThanOrEqual(1);
    expect(
      calls.some(
        (request) =>
          request.type === "setKickoffEffort" &&
          request.kind === "codex" &&
          request.effortId === "low",
      ),
    ).toBe(true);
  });

  it("selects a model for one sub without asserting access or cost", async () => {
    await bootOnAutomation();

    await clickDisplayed('[data-testid="kickoff-model-zai"]');
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
          "[data-testid^='kickoff-model-option-zai-']",
        ),
      );
      return {
        count: options.length,
        ids: options.map((option) => option.getAttribute("data-testid")),
        labels: options.map((option) => option.textContent ?? ""),
      };
    });
    expect(catalog.count).toBeGreaterThanOrEqual(2);
    expect(catalog.ids).toContain("kickoff-model-option-zai-glm-5.3");
    expect(catalog.labels.join(" ")).not.toContain("cheapest");
    await expect($('[data-testid="kickoff-model-note-zai"]')).toHaveText(
      expect.stringContaining("exposed by this harness"),
    );
    await expect($('[data-testid="kickoff-model-note-zai"]')).toHaveText(
      expect.stringContaining("does not guarantee plan access"),
    );

    // Enter on the already-selected entry would be a no-op (Radix only fires
    // on a value change), so move the highlight up to a different model and
    // confirm that one.
    await browser.keys("ArrowUp");
    await browser.keys("Enter");

    const calls = await dispatchCalls();
    const picks = calls.filter(
      (request) =>
        request.type === "setKickoffModel" &&
        request.kind === "zai" &&
        request.modelId === "glm-5.3",
    );
    expect(picks.length).toBeGreaterThanOrEqual(1);
    await expect($('[data-testid="kickoff-model-zai"]')).toHaveText(
      expect.stringContaining("GLM-5.3"),
    );
    await expect($('[data-testid="kickoff-model-codex"]')).toHaveText(
      expect.stringContaining("GPT-6 Luna"),
    );
  });

  it("explains reported-reset timing and quota use without promising rollover verification", async () => {
    await bootOnAutomation();

    const copy = await $('[data-testid="kickoff-copy-codex"]');
    await expect(copy).toHaveText(expect.stringContaining("reported reset time"));
    await expect(copy).toHaveText(expect.stringContaining("does not verify a rollover"));
    await expect(copy).toHaveText(expect.stringContaining("uses quota"));
    await expect(copy).toHaveText(expect.stringContaining("does not create, reset, or extend"));
  });

  it("warns honestly when the background scheduler is not installed", async () => {
    await bootOnAutomation();

    await clickDisplayed('[data-testid="kickoff-toggle-codex"]');

    await expectDisplayed('[data-testid="kickoff-scheduler-warn-codex"]');
    const warning = await $('[data-testid="kickoff-scheduler-warn-codex"]');
    expect(await warning.getText()).toContain("not installed");
  });
});
