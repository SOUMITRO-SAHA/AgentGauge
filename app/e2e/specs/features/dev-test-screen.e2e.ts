import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, browser, $ } from "@wdio/globals";

import {
  clickDisplayed,
  dashboardLive,
  dispatchCalls,
  expectDisplayed,
  clearSeededStores,
} from "../fixtures.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../",
);
const OUT = path.join(repoRoot, ".temp", "e2e", "dev-test-screen");

const STEPS = [
  { id: "welcome", title: "Your coding limits, in view" },
  { id: "statusCheck", title: "Know what you can trust" },
  { id: "windowRollover", title: "Catch the next reported window" },
  { id: "widget", title: "Keep usage in sight" },
  { id: "automation", title: "Watch without spending quota" },
];

async function expectTestFollowsSettings(): Promise<void> {
  const followsSettings = await browser.execute(() => {
    const settings = document.querySelector('[data-testid="nav-settings"]');
    const test = document.querySelector('[data-testid="nav-test"]');
    return Boolean(
      settings &&
        test &&
        settings.compareDocumentPosition(test) &
          Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
  expect(followsSettings).toBe(true);
}

async function resizeTo(width: number): Promise<void> {
  await browser.setWindowRect(60, 60, width, 720);
  for (let waited = 0; waited < 8000; waited += 250) {
    const actualWidth = await browser.execute(() => window.innerWidth);
    if (Math.abs(actualWidth - width) <= 16) return;
    await browser.pause(250);
  }
  throw new Error(`the window never reached a width near ${width}px`);
}

async function expectOnboardingButtonsFit(): Promise<void> {
  const overflowingButtons = await browser.execute(() => {
    const panel = document.querySelector(
      '[data-testid="test-onboarding-navigation"]',
    );
    const grid = panel?.querySelector(".grid");
    if (!grid) return ["onboarding navigation grid not found"];

    return Array.from(
      grid.querySelectorAll<HTMLElement>(
        '[data-testid^="test-onboarding-step-"]',
      ),
    )
      .filter((button) => button.scrollWidth > button.clientWidth)
      .map(
        (button) =>
          `${button.dataset.testid}: ${button.scrollWidth}px > ${button.clientWidth}px`,
      );
  });
  expect(overflowingButtons).toEqual([]);
}

after(() => {
  clearSeededStores();
});

describe("developer test screen", () => {
  beforeEach(async () => {
    await dashboardLive();
  });

  it("appears after Settings and opens every product screen", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    await resizeTo(960);
    await expectDisplayed('[data-testid="nav-test"]');
    await expectTestFollowsSettings();

    await clickDisplayed('[data-testid="nav-test"]');
    await expectDisplayed('[data-testid="view-test"]');
    await expectOnboardingButtonsFit();
    await browser.saveScreenshot(`${OUT}/wide.png`);
    await expect($('[data-testid="test-safety-note"]')).toHaveText(
      expect.stringContaining("never send a prompt or consume usage"),
    );

    for (const screen of ["home", "automation", "stats", "processes", "settings"]) {
      await clickDisplayed(`[data-testid="test-screen-${screen}"]`);
      await expectDisplayed(`[data-testid="view-${screen}"]`);
      await clickDisplayed('[data-testid="nav-test"]');
      await expectDisplayed('[data-testid="view-test"]');
    }

    for (const width of [500, 360]) {
      await resizeTo(width);
      await expectDisplayed('[data-testid="nav-test"]');
      await expectTestFollowsSettings();
      await expectOnboardingButtonsFit();
    }
    await browser.saveScreenshot(`${OUT}/compact.png`);
  });

  it("opens each onboarding step and replays the full flow without sending prompts", async () => {
    await clickDisplayed('[data-testid="nav-test"]');

    for (const step of STEPS) {
      await clickDisplayed(`[data-testid="test-onboarding-step-${step.id}"]`);
      await expectDisplayed('[data-testid="onboarding"]');
      await expect($('[data-testid="onboarding"] h1')).toHaveText(step.title);
      await clickDisplayed('[data-testid="onboarding-skip"]');
      await expectDisplayed('[data-testid="view-test"]');
    }

    await clickDisplayed('[data-testid="test-onboarding-replay"]');
    await expect($('[data-testid="onboarding"] h1')).toHaveText(STEPS[0].title);
    for (const step of STEPS.slice(1)) {
      await clickDisplayed('[data-testid="onboarding-next"]');
      await expect($('[data-testid="onboarding"] h1')).toHaveText(step.title);
    }
    await clickDisplayed('[data-testid="onboarding-next"]');
    await expectDisplayed('[data-testid="view-test"]');

    const calls = await dispatchCalls();
    expect(calls.some((request) => request.type === "sendPing")).toBe(false);
    expect(
      calls.some(
        (request) =>
          request.type === "setOnboardingStep" &&
          request.step === "done" &&
          request.dismissed === true,
      ),
    ).toBe(true);
  });
});
