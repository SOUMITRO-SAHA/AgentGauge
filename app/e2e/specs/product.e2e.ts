import { expect, browser, $ } from "@wdio/globals";

import {
  dashboardLive,
  dashboardUnavailable,
  installDispatch,
  liveSnapshot,
  onboardingVisible,
  onboardingWithNoData,
  settle,
} from "./fixtures.js";

/**
 * All product coverage, in one file and in a fixed order.
 *
 * ## Why one file
 *
 * The app is a single window, so every spec file drives the *same* renderer.
 * A `tauri.mock()` installed by one file therefore replaces the one the
 * previous file installed, and running files concurrently makes the fixtures
 * race — a spec asserts against whichever file installed last. Splitting this
 * into `app.e2e.ts` / `onboarding.e2e.ts` / `styling.e2e.ts` produced exactly
 * that flakiness.
 *
 * One file, one ordered sequence, one mock at a time.
 *
 * ## Ordering rules (see fixtures.ts)
 *
 * 1. `boot()` navigates, then installs the mock. Never the reverse: any
 *    navigation clears `window.__wdio_mocks__`, so mocking first is a silent
 *    no-op and the app reads the real provider.
 * 2. Never write the persisted store to set up a spec — the on-disk state is
 *    shared, so writing it races every other spec.
 * 3. A mock must answer *every* request the app makes, including the onboarding
 *    write. An unhandled request falls through to the default arm, and a decode
 *    failure there silently changes which screen renders.
 *
 * ## KNOWN FAILING — the onboarding gate
 *
 * The blocks below `onboarding flow` and `onboarding when nothing can be read`
 * currently fail in `beforeEach`, and several `dashboard` specs fail alongside
 * them. The cause is a harness constraint, not a product defect, and it is
 * verified rather than assumed:
 *
 *   - the onboarding gate is decided by an atom read that happens **on mount**;
 *   - a mock cannot exist before that read (see rule 1);
 *   - the control that would trigger a re-read lives *inside* the flow, which
 *     the gate itself is hiding.
 *
 * The gate is therefore un-mockable without a product change: seeding the
 * onboarding state from the URL (as the widget surface already does with
 * `?surface=widget`) would make it settable after navigation and unblock these
 * specs. Until then they are recorded as failing rather than deleted or
 * weakened into assertions that always pass.
 *
 * Verified against the real binary on macOS; see
 * `.opencode/skills/tauri-e2e-testing/references/capabilities.md`.
 */

describe("onboarding flow", () => {
  beforeEach(async () => {
    await onboardingVisible();
  });

  it("shows the welcome step first", async () => {
    await expect($('[data-testid="onboarding"]')).toBeDisplayed();
    await expect($("h1")).toHaveText("Never wait for a window again");
  });

  it("renders the detected Codex version on the status step", async () => {
    // This step is what proves the app reads the local install rather than
    // showing a picture of one.
    await $('[data-testid="onboarding-next"]').click();
    await expect($('[data-testid="demo-status"]')).toBeDisplayed();

    await expect($('[data-testid="provider-status"]')).toBeDisplayed();
    await expect($('[data-testid="codex-version"]')).toHaveText(
      "codex-cli 0.159.0",
    );
  });

  it("renders the 5-hour window with its percentage and reset countdown", async () => {
    await $('[data-testid="onboarding-next"]').click();
    await expect($('[data-testid="demo-status"]')).toBeDisplayed();

    // The bar renders REMAINING: 88% of the window is left.
    await expect($('[data-testid="window-bar"]')).toHaveAttribute(
      "data-tone",
      "healthy",
    );
    await expect($('[data-testid="window-reset"]')).toHaveText(
      expect.stringContaining("Resets in"),
    );
  });

  it("shows a setup button when the widget is not installed", async () => {
    for (let step = 0; step < 3; step += 1) {
      await $('[data-testid="onboarding-next"]').click();
    }
    await expect($('[data-testid="demo-widget"]')).toBeDisplayed();
    await expect($('[data-testid="widget-setup"]')).toBeDisplayed();
  });

  it("reports that the watcher is already running", async () => {
    for (let step = 0; step < 4; step += 1) {
      await $('[data-testid="onboarding-next"]').click();
    }
    await expect($('[data-testid="demo-automation"]')).toHaveText(
      expect.stringContaining("already running"),
    );
  });

  it("reaches the finish step", async () => {
    for (let step = 0; step < 5; step += 1) {
      await $('[data-testid="onboarding-next"]').click();
    }
    await expect($("h1")).toHaveText("Watching runs in the background");
    await expect($('[data-testid="onboarding-next"]')).toHaveText(
      expect.stringContaining("Finish"),
    );
  });

  it("persists the step through the protocol, not just local state", async () => {
    const mock = await browser.tauri.mock("dispatch");
    await mock.update();

    await $('[data-testid="onboarding-next"]').click();
    await browser.pause(400);

    // The write is what makes a relaunch resume rather than restart.
    const types = mock.mock.calls.map(
      (call) =>
        (call as { request?: { request?: { type?: string } } }).request?.request
          ?.type,
    );
    expect(types).toContain("setOnboardingStep");
  });

  it("skipping hides the flow and shows the dashboard", async () => {
    await $('[data-testid="onboarding-skip"]').click();
    await browser.pause(400);

    await expect($('[data-testid="onboarding"]')).toBeDisplayed({ reverse: true });
    await expect($('[data-testid="dashboard"]')).toBeDisplayed();
  });
});

describe("onboarding when nothing can be read", () => {
  beforeEach(async () => {
    await onboardingWithNoData();
  });

  it("states that Codex is not found rather than showing an empty dashboard", async () => {
    await $('[data-testid="onboarding-next"]').click();
    await expect($('[data-testid="demo-status"]')).toBeDisplayed();

    await expect($('[data-testid="provider-status"]')).toHaveText(
      expect.stringContaining("Codex CLI not found"),
    );
    // The install command is shown, so the user is not left guessing.
    await expect($('[data-testid="provider-status"]')).toHaveText(
      expect.stringContaining("npm install -g @openai/codex"),
    );
  });

  it("renders an explicit unavailable state, never a zero", async () => {
    await $('[data-testid="onboarding-next"]').click();
    await expect($('[data-testid="demo-status"]')).toBeDisplayed();

    // The reason must be visible. A `0% used` here would be a fabrication.
    await expect($('[data-testid="window-unavailable"]')).toBeDisplayed();
    await expect($('[data-testid="window-unavailable"]')).toHaveText(
      expect.stringContaining("codex login"),
    );
  });

  it("keeps the widget setup affordance available without data", async () => {
    for (let step = 0; step < 3; step += 1) {
      await $('[data-testid="onboarding-next"]').click();
    }
    await expect($('[data-testid="widget-setup"]')).toBeDisplayed();
  });
});

describe("dashboard", () => {
  beforeEach(async () => {
    await dashboardLive();
  });

  it("shows the dashboard once onboarding is dismissed", async () => {
    await expect($('[data-testid="dashboard"]')).toBeDisplayed();
    await expect($('[data-testid="onboarding"]')).toBeDisplayed({ reverse: true });
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
    await expect($('[data-testid="automation-status"]')).toHaveText("Running");
  });

  it("offers to set up the widget when it is absent", async () => {
    await expect($('[data-testid="widget-status"]')).toHaveText(
      expect.stringContaining("not open"),
    );
    await expect($('[data-testid="widget-toggle"]')).toHaveText(
      expect.stringContaining("Set up widget"),
    );
  });

  it("reaches the widget controller when the toggle is used", async () => {
    await $('[data-testid="widget-toggle"]').click();
    await settle("refresh-usage");

    // The fixture answers `setupWidget` with an installed status, so the button
    // flips to the remove affordance — proving the gesture reached the protocol.
    await expect($('[data-testid="widget-toggle"]')).toHaveText(
      expect.stringContaining("Remove"),
    );
  });
});

describe("dashboard when Codex is unavailable", () => {
  beforeEach(async () => {
    await dashboardUnavailable();
  });

  it("renders an explicit unavailable state, never a zero", async () => {
    await expect($('[data-testid="window-unavailable"]')).toBeDisplayed();
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

  it("reports the widget as already set up", async () => {
    await expect($('[data-testid="widget-status"]')).toHaveText(
      "Set up and always on top",
    );
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
      widgetInstalled: false,
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
    // The app ships to a 300px widget window as well as a desktop one, so a
    // horizontal scrollbar at any width is a layout defect.
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