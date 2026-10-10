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
      "Your coding limits, in view",
    );
    await expect($('[data-testid="onboarding"]')).toHaveText(
      expect.stringContaining("Codex is supported today; OpenCode and Pi are on the roadmap."),
    );
    await expectDisplayed('[data-testid="demo-welcome"]');
    await expectDisplayed('[data-testid="demo-welcome"] svg[data-art-icon="terminal"]');
    await expectDisplayed('[data-testid="demo-welcome"] svg[data-art-icon="code"]');
  });

  it("spaces the welcome icon cards apart from the panel with dotted connectors", async () => {
    const layout = await browser.execute(() => {
      const svg = document.querySelector('[data-testid="demo-welcome"] svg');
      const rectangles = [...(svg?.querySelectorAll("rect") ?? [])];
      const panel = rectangles.find(
        (rectangle) => rectangle.getAttribute("height") === "132",
      );
      const cards = rectangles
        .filter((rectangle) => rectangle.getAttribute("width") === "54")
        .map((rectangle) => rectangle.getBBox())
        .sort((left, right) => left.x - right.x);
      const panelBounds = panel?.getBBox();
      const connectors = [
        ...(svg?.querySelectorAll('path[stroke-dasharray]') ?? []),
      ].map((connector) => ({
        path: connector.getAttribute("d"),
        dash: connector.getAttribute("stroke-dasharray"),
      }));

      return {
        leftGap: panelBounds && cards[0]
          ? panelBounds.x - cards[0].x - cards[0].width
          : -1,
        rightGap: panelBounds && cards[1]
          ? cards[1].x - panelBounds.x - panelBounds.width
          : -1,
        connectors,
      };
    });

    expect(layout.leftGap).toBeGreaterThanOrEqual(16);
    expect(layout.rightGap).toBeGreaterThanOrEqual(16);
    expect(layout.connectors).toEqual([
      { path: "M 62 97 H 80", dash: "1 4" },
      { path: "M 240 103 H 258", dash: "1 4" },
    ]);
  });

  it("renders an illustration on the status step, not live provider UI", async () => {
    await clickDisplayed('[data-testid="onboarding-next"]');
    await expectDisplayed('[data-testid="demo-status"]');
    await expect($('[data-testid="onboarding"]')).toHaveText(
      expect.stringContaining("Missing or stale data is called out—not turned into zero."),
    );
    await expect($('[data-testid="onboarding"]')).toHaveText(
      expect.stringContaining("reset times, source, and last check"),
    );
    await expectDisplayed('[data-testid="demo-status"] svg[data-art-icon="verified"]');
    await expectDisplayed('[data-testid="demo-status"] svg[data-art-icon="freshness"]');

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
      expect.stringContaining("a prompt cannot start or extend a window"),
    );
    await expectDisplayed('[data-testid="demo-rollover"] svg[data-art-icon="observed"]');
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
      expect.stringContaining("You place it; macOS controls refresh timing."),
    );
    await expectDisplayed('[data-testid="demo-widget"] svg[data-art-icon="widget"]');
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
      expect.stringContaining("An optional, model-selected 'Hi' kickoff after a verified rollover is planned"),
    );
    await expect($('[data-testid="onboarding"]')).toHaveText(
      expect.stringContaining("without sending prompts or using quota"),
    );
    await expect($('[data-testid="onboarding"]')).toHaveText(
      expect.stringContaining("would consume usage and require your opt-in"),
    );
    await expectDisplayed('[data-testid="demo-automation"] svg[data-art-icon="watch"]');
    await expectDisplayed('[data-testid="demo-automation"] svg[data-art-icon="no-send"]');
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
      "Watch without spending quota",
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
      "Your coding limits, in view",
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
      "Know what you can trust",
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
