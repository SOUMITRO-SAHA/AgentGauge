import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, browser, $ } from "@wdio/globals";

import {
  clickDisplayed,
  dispatchCalls,
  expectDisplayed,
  onboardingVisible,
  onboardingWithNoData,
  restoreOnboardingStore,
} from "../fixtures.js";

const screenshots = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.temp/screenshots",
);

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

  it("centers the enlarged widget and pads its icons and rows", async () => {
    for (let step = 0; step < 3; step += 1) {
      await clickDisplayed('[data-testid="onboarding-next"]');
    }
    await expectDisplayed('[data-testid="demo-widget"]');

    const layout = await browser.execute(() => {
      const svg = document.querySelector('[data-testid="demo-widget"] svg');
      const card = svg?.querySelector<SVGGraphicsElement>('rect[stroke-width="2"]')?.getBBox();
      const badge = svg?.querySelector<SVGGraphicsElement>('circle[class*="fill-brand-teal"]')?.getBBox();
      const gauge = svg?.querySelector<SVGGraphicsElement>('path[class*="stroke-border"]')?.getBBox();
      const clock = svg?.querySelector<SVGSVGElement>('svg[class*="text-brand-teal"]');
      const calendar = svg?.querySelector<SVGSVGElement>('svg[class*="text-brand-amber"]');
      const rows = [...(svg?.querySelectorAll<SVGGraphicsElement>('rect[class="fill-surface-sunken"]') ?? [])]
        .map((row) => row.getBBox());

      return {
        cardWidth: card?.width ?? 0,
        viewportOffset: svg
          ? Math.abs(svg.getBoundingClientRect().left + svg.getBoundingClientRect().width / 2 - window.innerWidth / 2)
          : -1,
        groupCenter: card && badge
          ? (Math.min(card.x, badge.x) + Math.max(card.x + card.width, badge.x + badge.width)) / 2
          : -1,
        gaugeCenterOffset: card && gauge
          ? Math.abs(gauge.x + gauge.width / 2 - card.x - card.width / 2)
          : -1,
        iconInset: card && clock && calendar
          ? Math.min(Number(clock.getAttribute("x")) - card.x, Number(calendar.getAttribute("x")) - card.x)
          : -1,
        iconBottomInset: card && calendar
          ? card.y + card.height - Number(calendar.getAttribute("y")) - Number(calendar.getAttribute("height"))
          : -1,
        rowGap: clock && calendar && rows.length === 2
          ? Math.min(
            rows[0].x - Number(clock.getAttribute("x")) - Number(clock.getAttribute("width")),
            rows[1].x - Number(calendar.getAttribute("x")) - Number(calendar.getAttribute("width")),
          )
          : -1,
        rowRightInset: card && rows.length === 2
          ? Math.min(...rows.map((row) => card.x + card.width - row.x - row.width))
          : -1,
        rowBottomInset: card && rows.length === 2
          ? card.y + card.height - Math.max(...rows.map((row) => row.y + row.height))
          : -1,
      };
    });

    expect(layout.cardWidth).toBeGreaterThanOrEqual(156);
    expect(layout.viewportOffset).toBeLessThanOrEqual(2);
    expect(Math.abs(layout.groupCenter - 160)).toBeLessThanOrEqual(6);
    expect(layout.gaugeCenterOffset).toBeLessThanOrEqual(4);
    expect(layout.iconInset).toBeGreaterThanOrEqual(24);
    expect(layout.iconBottomInset).toBeGreaterThanOrEqual(24);
    expect(layout.rowGap).toBeGreaterThanOrEqual(8);
    expect(layout.rowRightInset).toBeGreaterThanOrEqual(20);
    expect(layout.rowBottomInset).toBeGreaterThanOrEqual(24);

    fs.mkdirSync(screenshots, { recursive: true });
    const image = path.join(screenshots, "onboarding-widget-inner-padding.png");
    await browser.saveScreenshot(image);
    expect(fs.statSync(image).size).toBeGreaterThan(1000);
  });

  it("keeps the monitor artwork centered with its lock inset from the card edge", async () => {
    for (let step = 0; step < 4; step += 1) {
      await clickDisplayed('[data-testid="onboarding-next"]');
    }
    await expectDisplayed('[data-testid="demo-automation"]');

    const layout = await browser.execute(() => {
      const svg = document.querySelector('[data-testid="demo-automation"] svg');
      const card = svg?.querySelector<SVGGraphicsElement>('rect[stroke-width="2"]:not([stroke-dasharray])')?.getBBox();
      const backdrop = svg?.querySelector<SVGGraphicsElement>('rect[stroke-dasharray]')?.getBBox();
      const circles = [...(svg?.querySelectorAll<SVGGraphicsElement>('circle') ?? [])]
        .map((circle) => circle.getBBox())
        .sort((left, right) => left.x - right.x);
      const wave = svg?.querySelector<SVGGraphicsElement>('path[stroke-linejoin]')?.getBBox();
      const bar = svg?.querySelector<SVGGraphicsElement>('rect[class*="fill-muted-foreground"]')?.getBBox();
      const [eye, lock] = circles;

      return {
        viewportOffset: svg
          ? Math.abs(svg.getBoundingClientRect().left + svg.getBoundingClientRect().width / 2 - window.innerWidth / 2)
          : -1,
        groupCenter: card && backdrop
          ? (Math.min(card.x, backdrop.x) + Math.max(card.x + card.width, backdrop.x + backdrop.width)) / 2
          : -1,
        lockTopInset: card && lock ? lock.y - card.y : -1,
        lockRightInset: card && lock ? card.x + card.width - lock.x - lock.width : -1,
        eyeBottomInset: card && eye ? card.y + card.height - eye.y - eye.height : -1,
        barTopInset: card && bar ? bar.y - card.y : -1,
        lockBarGap: lock && bar ? lock.x - bar.x - bar.width : -1,
        eyeWaveGap: eye && wave ? wave.x - eye.x - eye.width : -1,
        waveRightInset: card && wave ? card.x + card.width - wave.x - wave.width : -1,
      };
    });

    expect(layout.viewportOffset).toBeLessThanOrEqual(2);
    expect(Math.abs(layout.groupCenter - 160)).toBeLessThanOrEqual(6);
    expect(layout.lockTopInset).toBeGreaterThanOrEqual(24);
    expect(layout.lockRightInset).toBeGreaterThanOrEqual(24);
    expect(layout.eyeBottomInset).toBeGreaterThanOrEqual(24);
    expect(layout.barTopInset).toBeGreaterThanOrEqual(24);
    expect(layout.lockBarGap).toBeGreaterThanOrEqual(12);
    expect(layout.eyeWaveGap).toBeGreaterThanOrEqual(12);
    expect(layout.waveRightInset).toBeGreaterThanOrEqual(24);

    fs.mkdirSync(screenshots, { recursive: true });
    const image = path.join(screenshots, "onboarding-monitor-inner-padding.png");
    await browser.saveScreenshot(image);
    expect(fs.statSync(image).size).toBeGreaterThan(1000);
  });

  it("shows the monitor step as an illustration with no start control", async () => {
    for (let step = 0; step < 4; step += 1) {
      await clickDisplayed('[data-testid="onboarding-next"]');
    }
    await expectDisplayed('[data-testid="demo-automation"]');
    await expect($('[data-testid="onboarding"]')).toHaveText(
      expect.stringContaining("An optional kickoff can send one trivial 'Hi' with a model you choose about a minute after each 5-hour reset"),
    );
    await expect($('[data-testid="onboarding"]')).toHaveText(
      expect.stringContaining("without sending prompts or using quota"),
    );
    await expect($('[data-testid="onboarding"]')).toHaveText(
      expect.stringContaining("runs only if you opt in"),
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
