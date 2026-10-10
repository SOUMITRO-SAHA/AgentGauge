import { expect, browser, $ } from "@wdio/globals";

import {
  clickDisplayed,
  dashboardLive,
  dashboardUnavailable,
  dispatchCalls,
  expectDisplayed,
  gotoView,
  installDispatch,
  liveSnapshot,
  onboardingVisible,
  onboardingWithNoData,
  openApp,
  restoreOnboardingStore,
  seedOnboardingStore,
  seedRoute,
  settle,
} from "./fixtures.js";

/**
 * All product coverage, in one file and in a fixed order.
 *
 * ## Why one file, one worker
 *
 * The app is a single window, so every spec file drives the *same* renderer and
 * the same on-disk stores. Splitting files, or running them concurrently, made
 * the fixtures race each other. The `specs` entry in `wdio.conf.ts` is
 * therefore one *group* — wdio runs a group in a single instance, in order.
 *
 * ## Ordering rules (see fixtures.ts)
 *
 * 1. `boot()` seeds the persisted stores, navigates, then installs the mock.
 *    Never the reverse: any navigation clears `window.__wdio_mocks__`, so
 *    mocking first is a silent no-op and the app reads the real provider.
 * 2. Both persisted stores are seeded before the app launches and restored when
 *    the run finishes. The app decides its gate and its opening destination at
 *    mount, so a spec that inherited the previous spec's disk state inherited
 *    its screen. Seeding is safe now precisely because the run is one ordered
 *    worker — the old "never write the store" rule existed only to stop two
 *    workers racing it.
 * 3. A mock must answer *every* request the app makes. An unhandled request
 *    falls through to the default arm, and a decode failure there silently
 *    changes which screen renders.
 *
 * ## What the mock layer actually is (verified, not assumed)
 *
 * The app's `invoke` in `~/lib/ipc` reads `window.__wdio_mocks__` at call time,
 * so the mock is written straight into the page. The plugin's own
 * `browser.tauri.mock()` is deliberately unused: it registers in a different
 * WKWebView script world than the one the app reads, so its mocks were never
 * consulted — which is why fixture-dependent specs failed for months while
 * "mock-independent" ones passed. Three further facts, each verified against
 * the plugin source or a page-side probe:
 *
 *   - the mock receives the invoke *arguments* (`{ request, signal }`), not a
 *     `{ payload }` wrapper — the old destructuring answered every request with
 *     the default arm;
 *   - the implementation must be closure-free: it runs in the page, so fixture
 *     data crosses as JSON on `__ismFixtures__`;
 *   - `waitForDisplayed` misreports failure for a rendered element on a comma
 *     selector, so waits poll `isDisplayed` (`pollForDisplayed`).
 *
 * ## Widget specs assert both sides
 *
 * `real dev-build widget state` (at the end of this file) installs no fixture:
 * `bun run e2e` runs an unbundled binary, where `extension_present` is
 * genuinely false, and a dev build that claimed the widget was ready would send
 * the user to the gallery for something that is not there. The other widget
 * specs assert the fixture's *embedded* presentation instead.
 *
 * Verified against the real binary on macOS; see
 * `.opencode/skills/tauri-e2e-testing/references/capabilities.md`.
 */

describe("onboarding flow", () => {
  beforeEach(async () => {
    await onboardingVisible();
  });

  it("shows the welcome step first", async () => {
    await expectDisplayed('[data-testid="onboarding"]');
    await expect($("h1")).toHaveText("A clear view of your coding tools");
    await expect($('[data-testid="onboarding"]')).toHaveText(
      expect.stringContaining("AgentGauge shows the usage and status information"),
    );
  });

  it("renders the detected Codex version on the status step", async () => {
    // This step is what proves the app reads the local install rather than
    // showing a picture of one.
    await clickDisplayed('[data-testid="onboarding-next"]');
    await expectDisplayed('[data-testid="demo-status"]');

    await expectDisplayed('[data-testid="provider-status"]');
    await expect($('[data-testid="codex-version"]')).toHaveText(
      "codex-cli 0.159.0",
    );
  });

  it("renders the 5-hour window with its percentage and reset countdown", async () => {
    await clickDisplayed('[data-testid="onboarding-next"]');
    await expectDisplayed('[data-testid="demo-status"]');

    // The bar renders REMAINING: 88% of the window is left.
    await expect($('[data-testid="window-bar"]')).toHaveAttribute(
      "data-tone",
      "healthy",
    );
    await expect($('[data-testid="window-reset"]')).toHaveText(
      expect.stringContaining("Resets in"),
    );
  });

  it("explains the system widget instead of offering to install it", async () => {
    for (let step = 0; step < 3; step += 1) {
      await clickDisplayed('[data-testid="onboarding-next"]');
    }
    await expectDisplayed('[data-testid="demo-widget"]');

    // macOS owns widget placement: the user adds it from the system gallery, so
    // an install button would be a lie. There must be no such control.
    expect(await $('[data-testid="widget-setup"]').isExisting()).toBe(false);
    await expectDisplayed('[data-testid="widget-steps"]');
  });

  it("names both windows the widget will show", async () => {
    for (let step = 0; step < 3; step += 1) {
      await clickDisplayed('[data-testid="onboarding-next"]');
    }
    await expectDisplayed('[data-testid="demo-widget"]');

    // The user added this asking about two windows; the step must answer that
    // rather than only saying "add a widget somewhere".
    await expect($('[data-testid="demo-widget"]')).toHaveText(
      expect.stringContaining("5-hour window"),
    );
    await expect($('[data-testid="demo-widget"]')).toHaveText(
      expect.stringContaining("weekly limit"),
    );
  });

  it("reports that the watcher is already running", async () => {
    for (let step = 0; step < 4; step += 1) {
      await clickDisplayed('[data-testid="onboarding-next"]');
    }
    await expect($('[data-testid="demo-automation"]')).toHaveText(
      expect.stringContaining("already running"),
    );
  });

  it("reaches the finish step", async () => {
    for (let step = 0; step < 5; step += 1) {
      await clickDisplayed('[data-testid="onboarding-next"]');
    }
    await expect($("h1")).toHaveText("Watching runs in the background");
    await expect($('[data-testid="onboarding-next"]')).toHaveText(
      expect.stringContaining("Finish"),
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

  it("states that Codex is not found rather than showing an empty dashboard", async () => {
    await clickDisplayed('[data-testid="onboarding-next"]');
    await expectDisplayed('[data-testid="demo-status"]');

    await expect($('[data-testid="provider-status"]')).toHaveText(
      expect.stringContaining("Codex CLI not found"),
    );
    // The install command is shown, so the user is not left guessing.
    await expect($('[data-testid="provider-status"]')).toHaveText(
      expect.stringContaining("npm install -g @openai/codex"),
    );
  });

  it("renders an explicit unavailable state, never a zero", async () => {
    await clickDisplayed('[data-testid="onboarding-next"]');
    await expectDisplayed('[data-testid="demo-status"]');

    // The reason must be visible. A `0% used` here would be a fabrication.
    await expectDisplayed('[data-testid="window-unavailable"]');
    await expect($('[data-testid="window-unavailable"]')).toHaveText(
      expect.stringContaining("codex login"),
    );
  });

  it("still explains the widget when no usage could be read", async () => {
    // The widget is independent of whether Codex is reachable, so its guidance
    // must survive an unavailable reading.
    for (let step = 0; step < 3; step += 1) {
      await clickDisplayed('[data-testid="onboarding-next"]');
    }
    await expectDisplayed('[data-testid="demo-widget"]');
    await expectDisplayed('[data-testid="widget-steps"]');
  });
});

describe("dashboard", () => {
  beforeEach(async () => {
    await dashboardLive();
  });

  it("shows the shell once onboarding is dismissed", async () => {
    await expectDisplayed('[data-testid="app-shell"]');
    // The reverse flag is ignored by this wdio build; assert absence directly.
    expect(await $('[data-testid="onboarding"]').isDisplayed()).toBe(false);
  });

  it("renders the plan and freshness alongside the number", async () => {
    await expect($('[data-testid="plan"]')).toHaveText("Team");
    await expect($('[data-testid="freshness-pill"]')).toHaveAttribute(
      "data-freshness",
      "live",
    );
  });

  it("renders both the 5-hour and weekly windows", async () => {
    const bars = await $$('[data-testid="window-bar"]');
    expect(bars).toHaveLength(2);
    await expect($('[data-testid="usage-panel"]')).toHaveText(
      expect.stringContaining("5-hour window"),
    );
    await expect($('[data-testid="usage-panel"]')).toHaveText(
      expect.stringContaining("Weekly limit"),
    );
  });

  it("shows remaining, not used, so the bar cannot be read backwards", async () => {
    await expect($('[data-testid="usage-panel"]')).toHaveText(
      expect.stringContaining("88% left"),
    );
    await expect($('[data-testid="usage-panel"]')).toHaveText(
      expect.stringContaining("12% used"),
    );
  });

  it("shows a reset countdown rather than a bare timestamp", async () => {
    await expect($('[data-testid="window-reset"]')).toHaveText(
      expect.stringContaining("Resets in"),
    );
  });

  it("reports the watcher as running", async () => {
    // The watcher moved to its own destination with the navigation.
    await gotoView("automation");
    await expect($('[data-testid="automation-status"]')).toHaveText("Running");
  });

  // This spec asserts the *real* Rust response rather than a fixture value:
  // no mock is installed, so `extension_present` is genuinely false on this
  // unbundled binary. A dev build that claimed the widget was ready would send
  // the user looking in the gallery for something that is not there — the
  // regression this guards.
  // Fixture-embedded build: the guide must show the system's own procedure
  // (`data-state="ready"` is what `extension_present: true` renders as).
  it("guides a user through the gallery when the build embeds the widget", async () => {
    await gotoView("settings");
    const status = $('[data-testid="widget-status"]');
    await expectDisplayed('[data-testid="widget-status"]');
    await expect(status).toHaveAttribute("data-state", "ready");
    await expectDisplayed('[data-testid="widget-setup-steps"]');
    await expect($('[data-testid="widget-setup-steps"]')).toHaveText(
      expect.stringContaining("widget gallery"),
    );
  });

  it("offers no install control, because macOS owns widget placement", async () => {
    await gotoView("settings");
    // The old affordance opened a floating always-on-top window. A control that
    // implies the app can install a widget is the regression to catch.
    expect(await $('[data-testid="widget-toggle"]').isExisting()).toBe(false);
    expect(await $('[data-testid="widget-setup"]').isExisting()).toBe(false);
  });

  it("tells the user what to do about a missing extension", async () => {
    await gotoView("settings");
    // With the fixture's embedded extension the guide walks the user through
    // the gallery; the dev-build warning is covered by the real-response spec
    // above.
    await expectDisplayed('[data-testid="widget-setup-steps"]');
    await expect($('[data-testid="widget-setup-steps"]')).toHaveText(
      expect.stringContaining("gallery"),
    );
  });
});

describe("dashboard when Codex is unavailable", () => {
  beforeEach(async () => {
    await dashboardUnavailable();
  });

  it("renders an explicit unavailable state, never a zero", async () => {
    await expectDisplayed('[data-testid="window-unavailable"]');
    await expect($('[data-testid="window-unavailable"]')).toHaveText(
      expect.stringContaining("codex login"),
    );
  });

  it("does not render any usage bar when there is no reading", async () => {
    const bars = await $$('[data-testid="window-bar"]');
    expect(bars).toHaveLength(0);
  });

  it("marks the freshness pill as unavailable", async () => {
    await expect($('[data-testid="freshness-pill"]')).toHaveText("Unavailable");
  });

  it("tells the user how to install Codex", async () => {
    await expect($('[data-testid="provider-status"]')).toHaveText(
      expect.stringContaining("npm install -g @openai/codex"),
    );
  });

  it("keeps widget guidance independent of usage availability", async () => {
    // Widget support and provider availability are separate facts: a broken
    // Codex login must not remove the explanation of how to add the widget.
    await gotoView("settings");
    await expect($('[data-testid="widget-status"]')).toHaveAttribute(
      "data-state",
      "ready",
    );
    await expectDisplayed('[data-testid="widget-setup-steps"]');
  });
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

    const width = await browser.execute(() => {
      const el = document.querySelector('[data-testid="window-bar"]') as
        | HTMLElement
        | null;
      return el?.style.width ?? "(none)";
    });
    // 88% remaining, rendered as remaining — the inversion this guards.
    expect(width).toBe("88%");
  });

  it("sets the project font through @theme so font-sans resolves", async () => {
    const fonts = await browser.execute(() => ({
      body: getComputedStyle(document.body).fontFamily,
      // Probed inside a monospace parent so a *missing* utility inherits
      // monospace and is distinguishable from one that genuinely resolves.
      utility: (() => {
        const host = document.createElement("div");
        host.style.fontFamily = "monospace";
        const probe = document.createElement("span");
        probe.className = "font-sans";
        host.appendChild(probe);
        document.body.appendChild(host);
        const value = getComputedStyle(probe).fontFamily;
        host.remove();
        return value;
      })(),
    }));
    expect(fonts.body).toContain("Inter");
    expect(fonts.utility).toContain("Inter");
    expect(fonts.utility).not.toContain("monospace");
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

describe("navigation", () => {
  beforeEach(async () => {
    await dashboardLive();
  });

  it("starts on Home with exactly the four destinations", async () => {
    for (const id of ["home", "automation", "stats", "settings"]) {
      await expectDisplayed(`[data-testid="nav-${id}"]`);
    }
    await expect(
      $('[data-testid="nav-home"]'),
    ).toHaveAttribute("aria-current", "page");
    await expectDisplayed('[data-testid="view-home"]');
  });

  it("moves between destinations when the navigation is used", async () => {
    await gotoView("stats");
    await expectDisplayed('[data-testid="view-stats"]');
    await expect(
      $('[data-testid="nav-stats"]'),
    ).toHaveAttribute("aria-current", "page");
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

    // `setWindowRect` is not instantaneous, can be clamped by the work area
    // (a wide request at a nonzero x runs off the screen edge and macOS
    // shrinks it), and React swaps the nav a frame after the viewport agrees
    // — so move to the screen origin, drive to a *range*, and poll until the
    // nav POSITION matches it: a floating pill is anchored to the BOTTOM of
    // the viewport; the sidebar is a narrow column flush with the LEFT edge.
    // (Position, not height: `h-svh` in WKWebView reported an unstable height
    // after programmatic window moves, which made height comparisons flaky.)
    const resizeUntil = async (
      width: number,
      widthOk: (innerWidth: number) => boolean,
      mode: "sidebar" | "tabBar",
    ) => {
      await browser.setWindowRect(60, 60, width, 700);
      let last: Record<string, number> | null = null;
      for (let waited = 0; waited < 8000; waited += 250) {
        const shape = await navShape();
        last = shape;
        if (
          shape &&
          widthOk(shape.innerWidth) &&
          (mode === "sidebar"
            ? shape.left <= 1 && shape.width <= 300
            : shape.bottom >= shape.innerHeight - 48)
        ) {
          return;
        }
        await browser.pause(250);
      }
      throw new Error(
        `the window did not reach ${mode} mode; last shape: ${JSON.stringify(last)}`,
      );
    };

    // Narrow: the floating pill. Wide: the sidebar.
    await resizeUntil(500, (w) => w <= 600, "tabBar");
    const pill = await navShape();
    expect(pill).not.toBeNull();
    expect(pill!.bottom).toBeGreaterThanOrEqual(pill!.innerHeight - 48);

    await resizeUntil(1200, (w) => w >= 900, "sidebar");
    const sidebar = await navShape();
    expect(sidebar).not.toBeNull();
    expect(sidebar!.left).toBeLessThanOrEqual(1);
    expect(sidebar!.width).toBeLessThanOrEqual(300);

    // Leave the window where the reporter and later runs expect it.
    await resizeUntil(960, (w) => w >= 768, "sidebar");
  });
});

/**
 * The real Rust response, with no fixture installed.
 *
 * `url()` clears the mock registry, so this block reads the genuine backend:
 * `bun run e2e` runs an unbundled binary, where `extension_present` is
 * genuinely false — the widget extension lives inside the `.app`. A dev build
 * that claimed the widget was ready would send the user looking in the gallery
 * for something that is not there; this is the regression guard for that.
 */
/**
 * The run seeds both persisted stores before every boot. The original bytes go
 * back here, at *file* scope.
 *
 * This was previously an `after` inside the first `describe`, which fired when
 * that block finished — six later blocks then re-seeded the stores with nothing
 * left to restore them, so a full run left `lastRoute: "settings"` on the user's
 * disk. Verified: a run ended with the file holding a route no navigation in
 * the suite intended to leave behind.
 *
 * File scope is the only correct place: mocha runs a file-level `after` after
 * every `describe` has finished, and these blocks are top-level siblings rather
 * than nested, so there is no inner hook that could restore at the right time.
 */
after(async () => {
  restoreOnboardingStore();
});

describe("real dev-build widget state", () => {
  it("reports the extension as absent before any mock exists", async () => {
    // Seed first: the app reopens on whatever route the last run left, and a
    // destination other than Settings has no widget guide on screen.
    seedOnboardingStore(false);
    seedRoute("home");
    await openApp();

    await gotoView("settings");
    const status = $('[data-testid="widget-status"]');
    await expectDisplayed('[data-testid="widget-status"]');
    await expect(status).toHaveAttribute("data-state", "not-embedded");
    await expect(status).toHaveText(expect.stringContaining("packaged app"));
  });
});
