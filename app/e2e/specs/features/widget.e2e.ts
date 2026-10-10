import { expect, $ } from "@wdio/globals";

import {
  dashboardLive,
  dashboardUnavailable,
  expectDisplayed,
  gotoView,
  openApp,
  restoreOnboardingStore,
  seedOnboardingStore,
  seedRoute,
} from "../fixtures.js";

/**
 * The system widget: how the app reports it, and how it must never imply it
 * installed one.
 *
 * Runs in the single ordered group configured in `wdio.conf.ts`; the harness
 * rules that make that work live in `../fixtures.ts`. The persisted stores are
 * restored at *file* scope, which is the only place mocha runs an `after`
 * after every `describe` here has finished.
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
after(() => {
  restoreOnboardingStore();
});

describe("system widget", () => {
  beforeEach(async () => {
    await dashboardLive();
  });

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
    // below.
    await expectDisplayed('[data-testid="widget-setup-steps"]');
    await expect($('[data-testid="widget-setup-steps"]')).toHaveText(
      expect.stringContaining("gallery"),
    );
  });
});

describe("widget guidance without a usage reading", () => {
  beforeEach(async () => {
    await dashboardUnavailable();
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

/**
 * The real Rust response, with no fixture installed.
 *
 * `url()` clears the mock registry, so this block reads the genuine backend:
 * `bun run e2e` runs an unbundled binary, where `extension_present` is
 * genuinely false — the widget extension lives inside the `.app`. A dev build
 * that claimed the widget was ready would send the user looking in the gallery
 * for something that is not there; this is the regression guard for that.
 *
 * It lives in this file, after every fixture-driven block, so the `beforeEach`
 * mocks above cannot be in effect when it runs.
 */
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
