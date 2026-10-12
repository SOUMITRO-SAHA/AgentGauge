import { expect, browser, $ } from "@wdio/globals";

import {
  dashboardLive,
  dispatchCalls,
  expectDisplayed,
  gotoView,
  clearSeededStores,
} from "../fixtures.js";

/**
 * Navigation: the brand mark, the five destinations, the responsive
 * sidebar/tab-bar swap, and the persistence of the last one.
 *
 * Runs in the single ordered group configured in `wdio.conf.ts`; the harness
 * rules that make that work live in `../fixtures.ts`. The persisted stores are
 * restored at *file* scope, which is the only place mocha runs an `after`
 * after every `describe` here has finished.
 */
after(() => {
  clearSeededStores();
});

async function currentDestinations(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll(
        '[data-testid^="nav-"][aria-current="page"]',
      ),
    )
      .filter((element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      })
      .map((element) => element.getAttribute("data-testid"))
      .filter((testId): testId is string => testId !== null),
  );
}

describe("navigation", () => {
  beforeEach(async () => {
    await dashboardLive();
  });

  it("renders the AgentGauge brand mark in the foreground color", async () => {
    await expectDisplayed('[data-testid="brand-mark"]');
    await expect(
      $('[data-testid="brand-mark"]'),
    ).toHaveAttribute("aria-label", "AgentGauge brand mark");
    // The mark is an inline SVG driven by `currentColor`. The old `<img
    // src="/logo.svg">` carried its own `prefers-color-scheme` switch, and
    // WKWebView resolves that query inside image documents as light — so the
    // asset kept its dark ink on the dark sidebar and vanished while the file
    // itself loaded perfectly (naturalWidth was fine). If the fill ever stops
    // tracking the foreground token, the mark silently drops back to
    // dark-on-dark.
    const colors = await browser.execute(() => {
      const mark = document.querySelector('[data-testid="brand-mark"]');
      if (!mark) return null;
      return {
        fill: getComputedStyle(mark).fill,
        foreground: getComputedStyle(mark).color,
      };
    });
    expect(colors).not.toBeNull();
    expect(colors!.fill).not.toBe("rgba(0, 0, 0, 0)");
    expect(colors!.fill).toBe(colors!.foreground);
  });

  it("presents the wide-window sidebar as an inset floating pane", async () => {
    // `variant="floating"` exists only in the collapsible branch of the
    // primitive; with `collapsible="none"` no pane slot renders at all.
    await browser.setWindowRect(60, 60, 1200, 700);
    try {
      // macOS clamps setWindowRect asynchronously; wait until the viewport
      // agrees before asserting, or the mobile pill can still be mounted.
      await browser.waitUntil(async () => {
        const width = await browser.execute(() => window.innerWidth);
        return width >= 900;
      }, { timeout: 8000, timeoutMsg: "window never reached the wide breakpoint" });

      const pane = await $('[data-testid="nav"] [data-slot="sidebar-inner"]');
      await expect(pane).toBeDisplayed();
      const shape = await browser.execute(() => {
        const el = document.querySelector(
          '[data-testid="nav"] [data-slot="sidebar-inner"]',
        );
        if (!el) return null;
        const cs = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
          left: Math.round(rect.left),
          radius: Number.parseFloat(cs.borderTopLeftRadius),
        };
      });
      expect(shape).not.toBeNull();
      expect(shape!.left).toBeGreaterThan(0);
      expect(shape!.radius).toBeGreaterThan(0);
    } finally {
      // Leave the window where the reporter and later runs expect it.
      await browser.setWindowRect(60, 60, 960, 700);
    }
  });

  it("starts on Home with exactly the five destinations", async () => {
    for (const id of ["home", "automation", "stats", "processes", "settings"]) {
      await expectDisplayed(`[data-testid="nav-${id}"]`);
    }
    expect(await currentDestinations()).toEqual(["nav-home"]);
    await expectDisplayed('[data-testid="view-home"]');
  });

  it("moves between destinations when the navigation is used", async () => {
    await gotoView("stats");
    await expectDisplayed('[data-testid="view-stats"]');
    expect(await currentDestinations()).toEqual(["nav-stats"]);
    // `reverse: true` is silently ignored by this wdio build, so absence is
    // asserted on the displayed state directly.
    expect(await $('[data-testid="view-home"]').isDisplayed()).toBe(false);

    await gotoView("automation");
    await expectDisplayed('[data-testid="view-automation"]');
    expect(await $('[data-testid="view-stats"]').isDisplayed()).toBe(false);
  });

  it("switches a destination with the command digits", async () => {
    // ⌘3 = Stats, derived from ROUTES order (see navigation.test.ts).
    await browser.keys(["Meta", "3"]);
    await browser.pause(300);
    await expectDisplayed('[data-testid="view-stats"]');
  });

  it("persists a navigation through the protocol, not just local state", async () => {
    await gotoView("settings");
    await browser.pause(300);

    // The write is what makes the app reopen where the user left it. The mock
    // records it in the page, so a spec never writes the on-disk settings
    // file while still proving the protocol write happened.
    const writes = (await dispatchCalls()).filter(
      (request) => request.type === "setUiState",
    );
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.at(-1)?.lastRoute).toBe("settings");
  });

  it("is a sidebar on a wide window and a floating tab bar on a narrow one", async () => {
    // Asserted by geometry, not by class strings: the same testid serves both
    // presentations, and which one is right is a fact about its box.
    const navShape = () =>
      browser.execute(() => {
        const el = document.querySelector('[data-testid="nav"]');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          left: Math.round(rect.left),
          bottom: Math.round(rect.bottom),
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
        };
      });

    const widths = [360, 500, 768, 960, 1280];
    for (const width of widths) {
      await browser.setWindowSize(width, 700);
      await browser.waitUntil(
        async () => {
          const shape = await navShape();
          return Boolean(
            shape &&
              shape.innerWidth === width &&
              (width < 768
                ? shape.bottom >= shape.innerHeight - 48
                : shape.left <= 1 && shape.width <= 300),
          );
        },
        {
          timeout: 8000,
          timeoutMsg: `navigation did not reach its layout at ${width}px`,
        },
      );

      const shape = await navShape();
      expect(shape).not.toBeNull();
      if (width < 768) {
        const pillGap = shape!.innerHeight - shape!.bottom;
        expect(pillGap).toBeGreaterThanOrEqual(4);
        expect(pillGap).toBeLessThanOrEqual(24);
      } else {
        expect(shape!.left).toBeLessThanOrEqual(1);
        expect(shape!.width).toBeLessThanOrEqual(300);
      }

      await gotoView("stats");
      await expectDisplayed('[data-testid="view-stats"]');
      expect(await currentDestinations()).toEqual(["nav-stats"]);
    }

    await browser.setWindowSize(960, 700);
  });
});
