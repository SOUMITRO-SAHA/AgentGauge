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
const HEIGHTS = [480, 700];

const STEPS = [
  {
    title: "Your coding limits, in view",
    copy: "Codex is supported today; OpenCode and Pi are on the roadmap.",
    demo: "demo-welcome",
  },
  {
    title: "Know what you can trust",
    copy: "Missing or stale data is called out—not turned into zero.",
    demo: "demo-status",
  },
  {
    title: "Catch the next reported window",
    copy: "a prompt cannot start or extend a window",
    demo: "demo-rollover",
  },
  {
    title: "Keep usage in sight",
    copy: "You place it; macOS controls refresh timing.",
    demo: "demo-widget",
  },
  {
    title: "Watch without spending quota",
    copy: "An optional, model-selected 'Hi' kickoff after a verified rollover is planned",
    demo: "demo-automation",
  },
];

/**
 * Resizes to a target width and waits until the viewport agrees.
 *
 * `setWindowRect` is not instantaneous and macOS clamps to the work area and
 * the window's `minWidth` — the same discipline the shell's responsive spec
 * uses. The window moves to the screen origin first so a wide request cannot
 * run off the edge and get shrunk.
 */
async function resizeTo(width: number, height: number): Promise<void> {
  await browser.setWindowRect(60, 60, width, height);
  for (let waited = 0; waited < 8000; waited += 250) {
    const viewport = await browser.execute(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    if (
      Math.abs(viewport.width - width) <= 16 &&
      viewport.height <= height &&
      viewport.height >= height - 120
    ) {
      return;
    }
    await browser.pause(250);
  }
  throw new Error(`the window never reached a size near ${width}×${height}px`);
}

/** Asserts the no-scroll and flush-footer invariants for the current size. */
async function assertFits(): Promise<number> {
  const fit = await browser.execute(() => {
    const doc = document.documentElement;
    const flow = document.querySelector('[data-testid="onboarding"]');
    const content = flow?.querySelector('[data-testid="onboarding-content"]');
    const footer = flow?.querySelector("footer");
    const copy = content?.querySelector("section p");
    const art = content?.querySelector('[data-testid^="demo-"]');
    const progress = content?.querySelector('[data-testid="onboarding-progress"]');
    const progressLabel = content?.querySelector("header > div");
    const title = content?.querySelector("h1");
    const copyBottom = copy?.getBoundingClientRect().bottom ?? -1;
    const artTop = art?.getBoundingClientRect().top ?? -1;
    const artBottom = art?.getBoundingClientRect().bottom ?? -1;
    const progressTop = progress?.getBoundingClientRect().top ?? -1;
    const progressBottom = progress?.getBoundingClientRect().bottom ?? -1;
    const progressLabelBottom =
      progressLabel?.getBoundingClientRect().bottom ?? -1;
    const titleTop = title?.getBoundingClientRect().top ?? -1;
    const artWidth = art?.querySelector("svg")?.getBoundingClientRect().width ?? -1;
    const footerTop = footer?.getBoundingClientRect().top ?? -1;
    return {
      documentOverflowY: doc.scrollHeight - doc.clientHeight,
      documentOverflowX: doc.scrollWidth - doc.clientWidth,
      flowOverflowY: flow ? flow.scrollHeight - flow.clientHeight : -1,
      contentOverflowY: content
        ? content.scrollHeight - content.clientHeight
        : -1,
      labelProgressGap: progressTop - progressLabelBottom,
      progressTitleGap: titleTop - progressBottom,
      copyArtGap: artTop - copyBottom,
      artFooterGap: footerTop - artBottom,
      artWidth,
      footerGap: footer
        ? window.innerHeight - footer.getBoundingClientRect().bottom
        : -1,
    };
  });
  expect(fit.documentOverflowY).toBeLessThanOrEqual(0);
  expect(fit.documentOverflowX).toBeLessThanOrEqual(0);
  expect(fit.flowOverflowY).toBeLessThanOrEqual(0);
  expect(fit.contentOverflowY).toBeLessThanOrEqual(0);
  expect(fit.labelProgressGap).toBeGreaterThanOrEqual(20);
  expect(fit.progressTitleGap).toBeGreaterThanOrEqual(16);
  expect(fit.copyArtGap).toBeGreaterThanOrEqual(16);
  expect(fit.copyArtGap).toBeLessThanOrEqual(32);
  expect(fit.artFooterGap).toBeGreaterThanOrEqual(0);
  expect(Math.abs(fit.footerGap)).toBeLessThanOrEqual(1);
  return fit.artWidth;
}

async function assertProgress(stepNumber: number): Promise<void> {
  const progress = await browser.execute(() => {
    const root = document.querySelector(
      '[data-testid="onboarding-progress"]',
    );
    const indicator = root?.querySelector<HTMLElement>(
      '[data-slot="progress-indicator"]',
    );
    return {
      value: root?.getAttribute("aria-valuenow"),
      max: root?.getAttribute("aria-valuemax"),
      transform: indicator?.style.transform,
    };
  });
  expect(progress.value).toBe(String(stepNumber));
  expect(progress.max).toBe(String(STEPS.length));
  const offset = 100 - (stepNumber / STEPS.length) * 100;
  expect(progress.transform).toBe(
    `translateX(${offset === 0 ? 0 : -offset}%)`,
  );
}

describe("onboarding visual pass", () => {
  it("renders every step at every width without scrolling", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    await onboardingVisible();
    let compactArtWidth = 0;

    for (const width of WIDTHS) {
      for (const height of HEIGHTS) {
        await resizeTo(width, height);
        for (const [index, step] of STEPS.entries()) {
          await expectDisplayed(`[data-testid="${step.demo}"]`);
          await expect($('[data-testid="onboarding"] h1')).toHaveText(
            step.title,
          );
          await expect($('[data-testid="onboarding"]')).toHaveText(
            expect.stringContaining(step.copy),
          );
          expect(
            await $(`[data-testid="${step.demo}"] svg`).isExisting(),
          ).toBe(true);
          await assertProgress(index + 1);
          const artWidth = await assertFits();
          if (width === WIDTHS[0] && height === HEIGHTS[0] && index === 0) {
            compactArtWidth = artWidth;
          }
          if (width === WIDTHS[WIDTHS.length - 1] && height === HEIGHTS[1] && index === 0) {
            expect(artWidth).toBeGreaterThan(380);
            expect(artWidth).toBeGreaterThan(compactArtWidth);
          }
          await browser.saveScreenshot(
            `${OUT}/step${index + 1}-${width}-${height}.png`,
          );
          if (index < STEPS.length - 1) {
            await clickDisplayed('[data-testid="onboarding-next"]');
          }
        }
        for (let back = 0; back < STEPS.length - 1; back += 1) {
          await clickDisplayed('[data-testid="onboarding-back"]');
        }
        await expectDisplayed('[data-testid="demo-welcome"]');
      }
    }
  });
});
