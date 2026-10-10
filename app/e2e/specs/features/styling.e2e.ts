import { expect, browser } from "@wdio/globals";

import {
  dashboardLive,
  expectDisplayed,
  installDispatch,
  liveSnapshot,
  restoreOnboardingStore,
  settle,
} from "../fixtures.js";

/**
 * Cross-cutting chrome and layout: the platform flag, the shadcn primitives,
 * the font and theme tokens, and the responsive fit.
 *
 * Runs in the single ordered group configured in `wdio.conf.ts`; the harness
 * rules that make that work live in `../fixtures.ts`. The persisted stores are
 * restored at *file* scope, which is the only place mocha runs an `after`
 * after every `describe` here has finished.
 */
after(() => {
  restoreOnboardingStore();
});

describe("styling and chrome", () => {
  beforeEach(async () => {
    await dashboardLive();
  });

  it("sets exactly one platform chrome flag", async () => {
    // The macOS vibrancy layer is gated on this attribute, so it must always
    // carry one of the two values rather than being left undefined.
    const platform = await browser.execute(
      () => document.body.dataset.platform ?? "",
    );
    expect(["macos", "other"]).toContain(platform);
  });

  it("renders a filled primary action as a styled shadcn Button", async () => {
    // A specific testid, not "the first button": the footer leads with a ghost
    // Skip whose background is deliberately transparent.
    const style = await browser.execute(() => {
      const el = document.querySelector('[data-testid="refresh-usage"]');
      if (!el) throw new Error("refresh-usage not found");
      const computed = getComputedStyle(el);
      return {
        boxSizing: computed.boxSizing,
        backgroundColor: computed.backgroundColor,
        height: computed.height,
      };
    });
    expect(style.boxSizing).toBe("border-box");
    // A bare <button> lands near 21px; the `sm` variant is 32px.
    expect(parseFloat(style.height)).toBeCloseTo(32, 0);
  });

  it("renders a usage bar whose width tracks the remaining percentage", async () => {
    await installDispatch({
      visible: false,
      usage: liveSnapshot(),
      installed: true,
      version: "codex-cli 0.159.0",
      widgetEmbedded: true,
      widgetSupported: true,
      automationRunning: true,
    });
    await settle("refresh-usage");

    // The destination must be on screen and settled before the bar is read.
    // Without the wait this runs while the panel is still on its loading or
    // unavailable branch, and reads "(none)" from an element that does not
    // exist yet — which is what happened: the mock is installed here, mid-file,
    // and the previous spec's dismissal is still in effect.
    await expectDisplayed('[data-testid="view-home"]');
    await expectDisplayed('[data-testid="window-bar"]');

    // `querySelectorAll` rather than `querySelector`: both surfaces stay
    // mounted, so the first match is not necessarily the visible one.
    const width = await browser.execute(() => {
      const bars = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="window-bar"]'),
      );
      const bar = bars.find(
        (el) => getComputedStyle(el).display !== "none",
      );
      return bar?.style.width ?? "(none)";
    });
    // 88% remaining, rendered as remaining — the inversion this guards.
    expect(width).toBe("88%");
  });

  it("sets the project fonts through @theme so both faces resolve", async () => {
    const fonts = await browser.execute(() => {
      // Probed inside a monospace parent so a *missing* utility inherits
      // monospace and is distinguishable from one that genuinely resolves.
      const probe = (utility: string) => {
        const host = document.createElement("div");
        host.style.fontFamily = "monospace";
        const span = document.createElement("span");
        span.className = utility;
        host.appendChild(span);
        document.body.appendChild(host);
        const value = getComputedStyle(span).fontFamily;
        host.remove();
        return value;
      };
      const hero = document.querySelector('[data-testid="home-remaining"]');
      return {
        body: getComputedStyle(document.body).fontFamily,
        sans: probe("font-sans"),
        display: probe("font-display"),
        hero: hero ? getComputedStyle(hero).fontFamily : null,
      };
    });
    // Manrope is the default face — and the only one allowed on numbers: it
    // ships the `tnum` feature the `.tabular` readouts depend on. DM Sans has
    // no tabular figures (googlefonts/dm-fonts#25), so it is display-only and
    // must never sit on the hero readout, or the countdowns reflow per digit.
    expect(fonts.body).toContain("Manrope");
    expect(fonts.sans).toContain("Manrope");
    expect(fonts.sans).not.toContain("monospace");
    expect(fonts.display).toContain("DM Sans");
    expect(fonts.hero).toContain("Manrope");
    expect(fonts.hero).not.toContain("DM Sans");
  });

  it("resolves the theme tokens at runtime", async () => {
    const tokens = await browser.execute(() => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = "var(--background)";
      document.body.appendChild(probe);
      const background = getComputedStyle(probe).backgroundColor;
      probe.style.backgroundColor = "var(--primary)";
      const primary = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { background, primary };
    });
    // A transparent value would mean the token resolved to nothing.
    expect(tokens.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(tokens.primary).not.toBe("rgba(0, 0, 0, 0)");
  });
});

describe("responsive layout", () => {
  beforeEach(async () => {
    await dashboardLive();
  });

  it("does not overflow horizontally at a narrow width", async () => {
    // The window is resizable down to 360px, so a horizontal scrollbar at any
    // width is a layout defect.
    const overflow = await browser.execute(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  it("keeps every panel inside the viewport", async () => {
    const overflows = await browser.execute(() =>
      Array.from(document.querySelectorAll("[data-testid$='-panel']"))
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
        .map((el) => el.getAttribute("data-testid")),
    );
    expect(overflows).toEqual([]);
  });
});
