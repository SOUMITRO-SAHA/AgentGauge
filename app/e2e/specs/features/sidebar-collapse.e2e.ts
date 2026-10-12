import { expect, browser, $ } from "@wdio/globals";

import {
  clickDisplayed,
  dashboardLive,
  expectDisplayed,
  clearSeededStores,
} from "../fixtures.js";

/**
 * The wide-window sidebar's collapse and expand.
 *
 * Runs in the single ordered group configured in `wdio.conf.ts`; the harness
 * rules that make that work live in `../fixtures.ts`. The persisted stores are
 * restored at *file* scope, which is the only place mocha runs an `after`
 * after every `describe` here has finished.
 */
after(() => {
  clearSeededStores();
});

describe("sidebar collapse", () => {
  beforeEach(async () => {
    await dashboardLive();
  });

  /**
   * Moves the window to the wide presentation and waits for the sidebar.
   *
   * The same clamping dance as the floating-pane spec: macOS resizes
   * asynchronously and the primitive swaps a frame after the viewport agrees,
   * so poll until the viewport is genuinely wide.
   */
  async function wideWindow(): Promise<void> {
    await browser.setWindowRect(60, 60, 1200, 700);
    await browser.waitUntil(
      async () => (await browser.execute(() => window.innerWidth)) >= 900,
      { timeout: 8000, timeoutMsg: "window never reached the wide breakpoint" },
    );
  }

  /**
   * The collapse state.
   *
   * `data-testid="nav"` lands on the primitive's fixed *container* (the
   * component spreads `{...props}` there), which carries no state; the
   * `data-state`/`data-collapsible` pair lives on its parent, the outer
   * `group` div the collapse styling keys off.
   */
  const navState = () =>
    browser.execute(
      () =>
        document
          .querySelector('[data-testid="nav"]')
          ?.parentElement?.getAttribute("data-state") ?? null,
    );

  it("collapses from the brand-row trigger and expands from the parked control, with no rail", async () => {
    await wideWindow();
    try {
      // The draggable rail is gone: a strip along the whole pane edge that
      // toggled on any stray click is replaced by one explicit control.
      await expect($('[data-slot="sidebar-rail"]')).not.toBeExisting();

      // The toggle sits in the pane's own header: same row as the wordmark,
      // to its right.
      const row = await browser.execute(() => {
        const read = (selector: string) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            height: rect.height,
          };
        };
        return {
          trigger: read('[data-testid="sidebar-trigger"]'),
          mark: read('[data-testid="brand-mark"]'),
        };
      });
      expect(row.trigger).not.toBeNull();
      expect(row.mark).not.toBeNull();
      const triggerCenter = row.trigger!.top + row.trigger!.height / 2;
      const markCenter = row.mark!.top + row.mark!.height / 2;
      expect(Math.abs(triggerCenter - markCenter)).toBeLessThanOrEqual(4);
      expect(row.trigger!.left).toBeGreaterThan(row.mark!.right);

      await clickDisplayed('[data-testid="sidebar-trigger"]');
      await browser.waitUntil(async () => (await navState()) === "collapsed");

      // Collapsed: wordmark and trigger give way to the mark alone.
      expect(await $('[data-testid="brand-name"]').isDisplayed()).toBe(false);
      expect(await $('[data-testid="sidebar-trigger"]').isDisplayed()).toBe(
        false,
      );
      await expectDisplayed('[data-testid="brand-mark"]');
      await expect($('[data-slot="sidebar-rail"]')).not.toBeExisting();

      // The parked control expands again — the trigger is hidden while
      // collapsed, so the way back is the control outside the pane.
      await browser.execute(() =>
        (document.querySelector('[data-testid="nav-expand"]') as HTMLElement)
          .click(),
      );
      await browser.waitUntil(async () => (await navState()) === "expanded");
      await expectDisplayed('[data-testid="brand-name"]');
      await expectDisplayed('[data-testid="sidebar-trigger"]');
    } finally {
      await browser.setWindowRect(60, 60, 960, 700);
    }
  });

  it("parks a hidden expand control outside the collapsed pane, on the brand row", async () => {
    await wideWindow();
    try {
      // Expanded, the floating control does not exist at all — the trigger
      // on the brand row owns the toggle.
      const expanded = await browser.execute(() => {
        const el = document.querySelector('[data-testid="nav-expand"]');
        return el ? getComputedStyle(el).display : null;
      });
      expect(expanded).toBe("none");

      await clickDisplayed('[data-testid="sidebar-trigger"]');
      await browser.waitUntil(async () => (await navState()) === "collapsed");

      // Resting state: present for the click, invisible and click-through
      // until the pane is hovered. (The embedded driver exposes no pointer
      // actions, so the hover reveal itself is verified by the CSS contract
      // asserted here: opacity 0 + pointer-events none until group-hover.)
      const shape = await browser.execute(() => {
        const read = (selector: string) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return {
            rect: {
              left: rect.left, right: rect.right,
              top: rect.top, bottom: rect.bottom,
              height: rect.height,
            },
            display: cs.display,
            opacity: cs.opacity,
            pointerEvents: cs.pointerEvents,
          };
        };
        return {
          expand: read('[data-testid="nav-expand"]'),
          pane: read('[data-testid="nav"] [data-slot="sidebar-inner"]'),
          mark: read('[data-testid="brand-mark"]'),
        };
      });
      expect(shape.expand).not.toBeNull();
      expect(shape.pane).not.toBeNull();
      expect(shape.mark).not.toBeNull();
      expect(shape.expand!.display).not.toBe("none");
      expect(shape.expand!.opacity).toBe("0");
      expect(shape.expand!.pointerEvents).toBe("none");

      // Outside the pane, within a hand's reach of its edge.
      const gap =
        shape.expand!.rect.left - shape.pane!.rect.right;
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(16);
      // Same row as the brand mark: vertical centres agree.
      const expandCenter =
        shape.expand!.rect.top + shape.expand!.rect.height / 2;
      const markCenter =
        shape.mark!.rect.top + shape.mark!.rect.height / 2;
      expect(Math.abs(expandCenter - markCenter)).toBeLessThanOrEqual(4);

      // Its click re-expands, even though it is click-through at rest — a
      // page-side click exercises the handler the hover would.
      await browser.execute(() =>
        (document.querySelector('[data-testid="nav-expand"]') as HTMLElement)
          .click(),
      );
      await browser.waitUntil(async () => (await navState()) === "expanded");
      await expectDisplayed('[data-testid="brand-name"]');
    } finally {
      await browser.setWindowRect(60, 60, 960, 700);
    }
  });
});
