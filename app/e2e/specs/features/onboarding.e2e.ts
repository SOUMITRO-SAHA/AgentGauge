import { expect, browser, $ } from "@wdio/globals";

import {
  clickDisplayed,
  dispatchCalls,
  expectDisplayed,
  onboardingVisible,
  onboardingWithNoData,
  restoreOnboardingStore,
} from "../fixtures.js";

/**
 * Onboarding coverage: the flow itself, and how it behaves when nothing can be
 * read.
 *
 * Runs in the single ordered group configured in `wdio.conf.ts`; the harness
 * rules that make that work live in `../fixtures.ts`.
 *
 * The run seeds both persisted stores before every boot. The original bytes go
 * back here, at *file* scope.
 *
 * File scope is the only correct place: mocha runs a file-level `after` after
 * every `describe` has finished, and these blocks are top-level siblings rather
 * than nested, so there is no inner hook that could restore at the right time.
 */
after(() => {
  restoreOnboardingStore();
});

describe("onboarding flow", () => {
  beforeEach(async () => {
    await onboardingVisible();
  });

  it("shows the welcome step first", async () => {
    await expectDisplayed('[data-testid="onboarding"]');
    // Scoped to the flow: `$("h1")` answers for the FIRST h1 in the
    // document, and `AppShell` renders before `OnboardingFlow`, so an
    // unscoped selector reads the shell's heading instead of the step's.
    await expect($('[data-testid="onboarding"] h1')).toHaveText(
      "A clear, honest view of Codex usage",
    );
    await expect($('[data-testid="onboarding"]')).toHaveText(
      expect.stringContaining("Other harness integrations are planned, not assumed."),
    );
    await expectDisplayed('[data-testid="demo-welcome"]');
  });

  it("renders an illustration on the status step, not live provider UI", async () => {
    await clickDisplayed('[data-testid="onboarding-next"]');
    await expectDisplayed('[data-testid="demo-status"]');
    await expect($('[data-testid="onboarding"]')).toHaveText(
      expect.stringContaining("source and freshness, with a capture time when available"),
    );

    expect(await $('[data-testid="demo-status"] svg').isExisting()).toBe(true);
    // The step tells a story; it must not render a real reading. Both
    // selectors are scoped to the flow because the hidden shell keeps its own
    // live panels mounted behind it, and `$` answers for the first match in
    // document order.
    expect(
      await $('[data-testid="onboarding"] [data-testid="provider-status"]')
        .isExisting(),
    ).toBe(false);
    expect(
      await $('[data-testid="onboarding"] [data-testid="window-bar"]')
        .isExisting(),
    ).toBe(false);
  });

  it("renders an illustration on the rollover step", async () => {
    await clickDisplayed('[data-testid="onboarding-next"]');
    await clickDisplayed('[data-testid="onboarding-next"]');
    await expectDisplayed('[data-testid="demo-rollover"]');
    await expect($('[data-testid="onboarding"]')).toHaveText(
      expect.stringContaining("never resets or extends it"),
    );
    expect(await $('[data-testid="demo-rollover"] svg').isExisting()).toBe(true);
    expect(
      await $('[data-testid="onboarding"] [data-testid="window-bar"]')
        .isExisting(),
    ).toBe(false);
  });

  it("explains the system widget without offering to install it", async () => {
    for (let step = 0; step < 3; step += 1) {
      await clickDisplayed('[data-testid="onboarding-next"]');
    }
    await expectDisplayed('[data-testid="demo-widget"]');
    await expect($('[data-testid="onboarding"]')).toHaveText(
      expect.stringContaining("macOS widget gallery"),
    );
    expect(await $('[data-testid="demo-widget"] svg').isExisting()).toBe(true);

    // macOS owns widget placement: the user adds it from the system gallery,
    // so an install control would be a lie. There must be no such control.
    expect(await $('[data-testid="widget-toggle"]').isExisting()).toBe(false);
    expect(
      await $('[data-testid="onboarding"] [data-testid="widget-setup"]')
        .isExisting(),
    ).toBe(false);
  });

  it("keeps real widget status out of the flow", async () => {
    for (let step = 0; step < 3; step += 1) {
      await clickDisplayed('[data-testid="onboarding-next"]');
    }
    await expectDisplayed('[data-testid="demo-widget"]');
    expect(
      await $('[data-testid="onboarding"] [data-testid="widget-status"]')
        .isExisting(),
    ).toBe(false);
  });

  it("shows the monitor step as an illustration with no start control", async () => {
    for (let step = 0; step < 4; step += 1) {
      await clickDisplayed('[data-testid="onboarding-next"]');
    }
    await expectDisplayed('[data-testid="demo-automation"]');
    await expect($('[data-testid="onboarding"]')).toHaveText(
      expect.stringContaining("never sends a prompt or spends quota"),
    );
    expect(await $('[data-testid="demo-automation"] svg').isExisting()).toBe(
      true,
    );
    // Starting the monitor is a dashboard action (Automation view); a
    // decorative step must not carry it.
    expect(
      await $('[data-testid="onboarding"] [data-testid="automation-start"]')
        .isExisting(),
    ).toBe(false);
  });

  it("reaches the finish step", async () => {
    for (let step = 0; step < 4; step += 1) {
      await clickDisplayed('[data-testid="onboarding-next"]');
    }
    await expect($('[data-testid="onboarding"] h1')).toHaveText(
      "A read-only rollover monitor",
    );
    await expect($('[data-testid="onboarding-next"]')).toHaveText(
      expect.stringContaining("Finish"),
    );
  });

  it("walks back to an earlier step without dismissing the flow", async () => {
    await clickDisplayed('[data-testid="onboarding-next"]');
    await expectDisplayed('[data-testid="demo-status"]');
    await clickDisplayed('[data-testid="onboarding-back"]');
    await expectDisplayed('[data-testid="demo-welcome"]');
    await expect($('[data-testid="onboarding"] h1')).toHaveText(
      "A clear, honest view of Codex usage",
    );
  });

  it("persists the step through the protocol, not just local state", async () => {
    await clickDisplayed('[data-testid="onboarding-next"]');
    await browser.pause(400);

    // The write is what makes a relaunch resume rather than restart. The call
    // log lives next to the page-side mock (the plugin's own handle records
    // in a different script world), so it is read from the page.
    const types = (await dispatchCalls()).map(
      (request) => request.type as string | undefined,
    );
    expect(types).toContain("setOnboardingStep");
  });

  it("persists completion when the user finishes the last step", async () => {
    for (let step = 0; step < 4; step += 1) {
      await clickDisplayed('[data-testid="onboarding-next"]');
    }
    await clickDisplayed('[data-testid="onboarding-next"]');
    await browser.pause(400);

    const completion = (await dispatchCalls()).find(
      (request) => request.type === "setOnboardingStep" && request.step === "done",
    );
    expect(completion?.dismissed).toBe(true);
  });

  it("skipping hides the flow and shows the dashboard", async () => {
    await clickDisplayed('[data-testid="onboarding-skip"]');
    await browser.pause(400);

    // `toBeDisplayed({ reverse: true })` is silently ignored by this wdio
    // build, so absence is asserted on the displayed state directly.
    expect(await $('[data-testid="onboarding"]').isDisplayed()).toBe(false);
    await expectDisplayed('[data-testid="app-shell"]');
  });
});

describe("onboarding when nothing can be read", () => {
  beforeEach(async () => {
    await onboardingWithNoData();
  });

  it("renders the same steps when Codex is missing", async () => {
    await expectDisplayed('[data-testid="demo-welcome"]');
    await clickDisplayed('[data-testid="onboarding-next"]');
    await expectDisplayed('[data-testid="demo-status"]');
    await expect($('[data-testid="onboarding"] h1')).toHaveText(
      "Every reading keeps its source",
    );
  });

  it("never renders a fabricated reading inside the flow", async () => {
    // No data arrived, so no number may appear: the steps are illustrations
    // and copy only. Scoped to the flow; the hidden shell renders its own
    // explicit unavailable state behind it.
    expect(
      await $('[data-testid="onboarding"] [data-testid="window-bar"]')
        .isExisting(),
    ).toBe(false);
    expect(
      await $('[data-testid="onboarding"] [data-testid="window-unavailable"]')
        .isExisting(),
    ).toBe(false);
    expect(
      await $('[data-testid="onboarding"] [data-testid="provider-status"]')
        .isExisting(),
    ).toBe(false);
  });
});
