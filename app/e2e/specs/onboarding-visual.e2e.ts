import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browser, $, expect } from "@wdio/globals";

import {
  clickDisplayed,
  expectDisplayed,
  onboardingVisible,
} from "./fixtures.js";

/**
 * A visual and geometric pass over the onboarding flow.
 *
 * Walks all five steps at several window sizes and saves one screenshot per
 * step×size to the standard artifact location (repo-root `.temp/e2e/`,
 * resolved from this file so the path holds regardless of the runner's
 * working directory). Along the way it asserts the two layout invariants the
 * flow must hold at every size:
 *
 * 1. **Nothing scrolls.** Neither the document nor the flow may report more
 *    content than it has room for.
 * 2. **The footer is flush with the bottom edge.** A gap between the footer
 *    and the window bottom is the "dead band" regression this guards.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const OUT = path.join(repoRoot, ".temp", "e2e", "onboarding");

const WIDTHS = [360, 500, 768, 1280];
const HEIGHT = 700;

const STEPS = [
  { title: "A clear view of your coding tools", demo: "demo-welcome" },
  { title: "Live status, with its source attached", demo: "demo-status" },
  { title: "It notices the moment a window resets", demo: "demo-rollover" },
  { title: "A real macOS widget", demo: "demo-widget" },
  { title: "Watching runs in the background", demo: "demo-automation" },
];

/**
 * Resizes to a target width and waits until the viewport agrees.
 *
 * `setWindowRect` is not instantaneous and macOS clamps to the work area and
 * the window's `minWidth` — the same discipline the shell's responsive spec
 * uses. The window moves to the screen origin first so a wide request cannot
 * run off the edge and get shrunk.
 */
async function resizeTo(width: number): Promise<void> {
  await browser.setWindowRect(60, 60, width, HEIGHT);
  for (let waited = 0; waited < 8000; waited += 250) {
    const innerWidth = await browser.execute(() => window.innerWidth);
    if (Math.abs(innerWidth - width) <= 16) return;
    await browser.pause(250);
  }
  throw new Error(`the window never reached a width near ${width}px`);
}

/** Asserts the no-scroll and flush-footer invariants for the current size. */
async function assertFits(): Promise<void> {
  const fit = await browser.execute(() => {
    const doc = document.documentElement;
    const flow = document.querySelector('[data-testid="onboarding"]');
    const footer = flow?.querySelector("footer");
    return {
      documentOverflowY: doc.scrollHeight - doc.clientHeight,
      documentOverflowX: doc.scrollWidth - doc.clientWidth,
      flowOverflowY: flow ? flow.scrollHeight - flow.clientHeight : -1,
      footerGap: footer
        ? window.innerHeight - footer.getBoundingClientRect().bottom
        : -1,
    };
  });
  expect(fit.documentOverflowY).toBeLessThanOrEqual(0);
  expect(fit.documentOverflowX).toBeLessThanOrEqual(0);
  expect(fit.flowOverflowY).toBeLessThanOrEqual(0);
  expect(Math.abs(fit.footerGap)).toBeLessThanOrEqual(1);
}

describe("onboarding visual pass", () => {
  it("renders every step at every width without scrolling", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    await onboardingVisible();

    for (const width of WIDTHS) {
      await resizeTo(width);
      for (const [index, step] of STEPS.entries()) {
        await expectDisplayed(`[data-testid="${step.demo}"]`);
        // Scoped to the flow: the hidden shell renders its own h1 first.
        await expect($('[data-testid="onboarding"] h1')).toHaveText(
          step.title,
        );
        expect(
          await $(`[data-testid="${step.demo}"] svg`).isExisting(),
        ).toBe(true);
        await assertFits();
        await browser.saveScreenshot(
          `${OUT}/step${index + 1}-${width}.png`,
        );
        if (index < STEPS.length - 1) {
          await clickDisplayed('[data-testid="onboarding-next"]');
        }
      }
      // Return to the first step for the next width. The Back control is the
      // real gesture; four clicks undo the four advances above.
      for (let back = 0; back < STEPS.length - 1; back += 1) {
        await clickDisplayed('[data-testid="onboarding-back"]');
      }
      await expectDisplayed('[data-testid="demo-welcome"]');
    }
  });
});
