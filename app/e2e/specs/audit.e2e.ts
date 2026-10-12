/**
 * A visual audit, not an assertion suite.
 *
 * Drives the real app to each destination at several widths and saves a
 * screenshot per combination, so spacing and rhythm can be judged by eye
 * against real renders rather than inferred from class names.
 *
 * Run directly (not via `bun run e2e`), because it asserts nothing and would
 * otherwise dilute the suite's signal.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browser } from "@wdio/globals";

import {
  dashboardLive,
  gotoView,
  installDispatch,
  liveSnapshot,
  openApp,
  settle,
} from "./fixtures.js";

// Repo-root `.temp/e2e`, the project's standard artifact location, resolved
// from this file so it holds regardless of the directory the runner was
// launched from. See `tauri-e2e-testing/SKILL.md`.
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const OUT = path.join(repoRoot, ".temp", "e2e", "audit");

const WIDTHS = [360, 500, 768, 960, 1280];
const HEIGHT = 820;

/** The vertical gaps between the shell's direct children, in CSS pixels. */
function readRhythm() {
  const shell = document.querySelector('[data-testid="app-shell"]');
  const column = shell?.querySelector('[data-testid="view-home"], [data-testid="view-stats"]')
    ?.parentElement;
  if (!column) return null;
  const kids = Array.from(column.children).filter((el) => {
    const style = getComputedStyle(el);
    return style.display !== "none" && el.getBoundingClientRect().height > 0;
  });
  return {
    viewport: window.innerWidth,
    overflow:
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
    columnWidth: Math.round(column.getBoundingClientRect().width),
    maxWidth: getComputedStyle(column).maxWidth,
    insetWidth: Math.round(
      column.parentElement?.getBoundingClientRect().width ?? 0,
    ),
    gaps: kids
      .slice(1)
      .map((el, i) =>
        Math.round(
          el.getBoundingClientRect().top -
            kids[i].getBoundingClientRect().bottom,
        ),
      ),
    padding: (() => {
      const style = getComputedStyle(column);
      return `${style.paddingTop}/${style.paddingBottom}`;
    })(),
  };
}

describe("visual audit", () => {
  it("captures each destination at each width", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    await dashboardLive();
    await installDispatch({
      visible: false,
      usage: liveSnapshot({ plan: "pro" }),
      installed: true,
      version: "codex-cli 0.159.0",
      widgetEmbedded: true,
      widgetSupported: true,
      automationRunning: true,
    });
    await settle("refresh-usage");

    for (const width of WIDTHS) {
      await browser.setWindowSize(width, HEIGHT);
      await browser.pause(700);
      for (const view of ["home", "stats", "automation", "settings"] as const) {
        // Click the control that is actually on screen. `gotoView` uses
        // `firstDisplayed`, which is right, but the active-state read below must
        // likewise inspect every match — the pill and the sidebar both carry
        // `nav-<route>`, and only one of them is rendered at a given width.
        await gotoView(view);
        await settle(
          view === "home"
            ? "refresh-usage"
            : view === "automation"
              ? "refresh-automation"
              : view === "settings"
                ? "refresh-widget"
                : "refresh-usage",
        );
        // The screenshot must be taken *after* confirming the destination is
        // actually on screen. Saving first captures whatever the previous
        // iteration left rendered, which is how a file named `home-360` ended up
        // holding the Automation screen.
        const shown = await browser.execute((wanted: string) => {
          const el = document.querySelector(`[data-testid="view-${wanted}"]`);
          return el ? getComputedStyle(el).display !== "none" : false;
        }, view);
        if (!shown) {
          throw new Error(`view-${view} was not displayed at ${width}px`);
        }
        // The visible control must agree with the view. Asserting on `$()`
        // instead would read the sidebar's copy — correct at wide widths, and a
        // stale highlight at narrow ones, which is how a wrong screenshot gets
        // saved and then read as a layout bug.
        const active = await browser.execute((wanted: string) => {
          const nodes = Array.from(
            document.querySelectorAll(`[data-testid="nav-${wanted}"]`),
          );
          return nodes.some((el) => {
            const style = getComputedStyle(el);
            const bounds = el.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              bounds.width > 0 &&
              bounds.height > 0 &&
              el.getAttribute("aria-current") === "page"
            );
          });
        }, view);
        if (!active) {
          throw new Error(
            `the visible nav-${view} was not aria-current at ${width}px`,
          );
        }
        await browser.pause(500);
        const rhythm = await browser.execute(readRhythm);
        console.log(
          `AUDIT ${view}@${width}:`,
          JSON.stringify(rhythm),
        );
        await browser.saveScreenshot(`${OUT}/${view}-${width}.png`);
      }
    }
  });
});
