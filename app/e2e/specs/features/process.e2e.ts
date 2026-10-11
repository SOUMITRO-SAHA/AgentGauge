import { expect, browser, $, $$ } from "@wdio/globals";

import {
  expectDisplayed,
  gotoView,
  processScreenLive,
  restoreOnboardingStore,
} from "../fixtures.js";

/**
 * Processes-view coverage: the read-only process and storage screen.
 *
 * The groups the mock returns are the groups the screen must render — the
 * panel set is backend-driven, so a future CLI lands with no renderer change
 * — and every explicit state is asserted: rows with memory and uptime,
 * measured storage with its breakdown, absent storage as a reason, an empty
 * group as a sentence, and the screen's read-onlyness as "the only buttons
 * are refreshes".
 */
after(() => {
  restoreOnboardingStore();
});

describe("processes", () => {
  beforeEach(async () => {
    await processScreenLive();
  });

  it("sits between Stats and Settings in the navigation", async () => {
    await expectDisplayed('[data-testid="nav-processes"]');

    const order = await browser.execute(() =>
      Array.from(document.querySelectorAll('[data-testid^="nav-"]')).map(
        (element) => element.getAttribute("data-testid"),
      ),
    );
    const ids = order.filter((id) => id !== null);
    const at = (needle: string) => ids.findIndex((id) => id === `nav-${needle}`);
    expect(at("stats")).toBeGreaterThanOrEqual(0);
    expect(at("processes")).toBeGreaterThan(at("stats"));
    expect(at("settings")).toBeGreaterThan(at("processes"));
  });

  it("switches with the command digits derived from the route order", async () => {
    // ⌘4 = Processes, derived from ROUTES order (see navigation.test.ts).
    await browser.keys(["Meta", "4"]);
    await browser.pause(300);
    await expectDisplayed('[data-testid="view-processes"]');
  });

  it("renders every group's processes with memory and uptime", async () => {
    await gotoView("processes");
    await expectDisplayed('[data-testid="process-panel-agentgauge"]');
    await expectDisplayed('[data-testid="process-panel-codex"]');
    await expectDisplayed('[data-testid="process-panel-opencode"]');

    const pid = 4242;
    await expectDisplayed(`[data-testid="process-row-${pid}"]`);
    await expect($(`[data-testid="process-memory-${pid}"]`)).toHaveText("432 MB");
    await expect($(`[data-testid="process-uptime-${pid}"]`)).toHaveText(
      expect.stringContaining("1h"),
    );
    await expect($('[data-testid="process-totals-agentgauge"]')).toHaveText(
      expect.stringContaining("432 MB"),
    );
  });

  it("shows a measured storage breakdown, with rows summing to a total", async () => {
    await gotoView("processes");
    await expectDisplayed('[data-testid="process-storage-codex"]');

    const text = await $('[data-testid="process-storage-codex"]').getText();
    expect(text).toContain("Storage");
    expect(text).toContain("Session transcripts");
    expect(text).toContain("432 MB");
    await expect($('[data-testid="process-totals-codex"]')).toHaveText(
      expect.stringContaining("500 MB"),
    );
  });

  it("renders an absent footprint as its reason, never as zero bytes", async () => {
    await gotoView("processes");
    await expectDisplayed('[data-testid="process-storage-absent-opencode"]');
    await expect($('[data-testid="process-storage-absent-opencode"]')).toHaveText(
      expect.stringContaining("has not created"),
    );
    expect(await $$('[data-testid="process-storage-opencode"]')).toHaveLength(0);
  });

  it("says explicitly when a group has nothing running", async () => {
    await gotoView("processes");
    await expectDisplayed('[data-testid="process-empty-opencode"]');
    await expect($('[data-testid="process-empty-opencode"]')).toHaveText(
      expect.stringContaining("No OpenCode processes"),
    );
    expect(await $$('[data-testid^="process-row-"]')).toHaveLength(3);
  });

  it("offers no control beyond refresh, because the capability has no write", async () => {
    await gotoView("processes");

    const buttons = await $$('[data-testid="view-processes"] button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      const testid = await button.getAttribute("data-testid");
      expect(testid?.startsWith("refresh-processes-")).toBe(true);
    }

    await expect($('[data-testid="process-readonly-note"]')).toHaveText(
      expect.stringContaining("only reads"),
    );
  });
});
