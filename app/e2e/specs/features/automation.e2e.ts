import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, $, $$, browser } from "@wdio/globals";

import {
  boot,
  clickDisplayed,
  dispatchCalls,
  gotoView,
  liveSnapshot,
  clearSeededStores,
  subscription,
  type DispatchFixtures,
} from "../fixtures.js";

/**
 * The Automation view: every connected sub gets its own rollover monitor, and
 * the running state reads as a *persisted choice* — a sub the fixture says was
 * enabled arrives Running before any click, because the backend resumes
 * persisted choices at launch. Toggling records the write for exactly that
 * sub.
 *
 * Runs in the single ordered group configured in `wdio.conf.ts`; the harness
 * rules that make that work live in `../fixtures.ts`. The persisted stores are
 * restored at *file* scope, which is the only place mocha runs an `after`
 * after every `describe` here has finished.
 */
after(() => {
  clearSeededStores();
});

/** Codex (enabled, the persisted default under test) beside a connected Z.AI. */
async function bootAutomation(
  overrides: Partial<DispatchFixtures> = {},
): Promise<void> {
  await boot({
    visible: false,
    usage: liveSnapshot(),
    installed: true,
    version: "codex-cli 0.159.0",
    widgetEmbedded: true,
    widgetSupported: true,
    automationRunning: true,
    subscriptions: [subscription()],
    ...overrides,
  });
  await gotoView("automation");
}

async function captureAutomationScreenshot(
  connection: "codex" | "zai",
): Promise<void> {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );
  const directory = path.join(repoRoot, ".temp", "screenshots");
  const file = path.join(directory, `automation-${connection}.png`);
  fs.mkdirSync(directory, { recursive: true });
  const screenshot = await browser.saveScreenshot(file);
  expect(screenshot.subarray(1, 4).toString()).toBe("PNG");
  expect(fs.statSync(file).size).toBeGreaterThan(1000);
}

describe("automation", () => {
  it("keeps every connection status visible and focuses one detail panel", async () => {
    await bootAutomation();

    const codexTab = $('[data-testid="automation-connection-tab-codex"]');
    const zaiTab = $('[data-testid="automation-connection-tab-zai"]');
    await expect(codexTab).toHaveText(expect.stringContaining("Codex"));
    await expect(codexTab).toHaveText(expect.stringContaining("Running"));
    await expect(zaiTab).toHaveText(expect.stringContaining("Z.AI"));
    await expect(zaiTab).toHaveText(expect.stringContaining("Stopped"));
    await expect($('[data-testid="automation-panel-codex"] h2')).toHaveText(
      "Codex",
    );
    await expect($('[data-testid="automation-panel-zai"]')).not.toExist();
    expect(await $$('[data-testid="automation-loading-skeleton"]')).toHaveLength(
      0,
    );
    expect(await $$('[data-testid^="kickoff-loading-"]')).toHaveLength(0);
    await expect($('[data-testid="automation-panel-kimi"]')).not.toExist();

    const layout = await browser.execute(() => {
      const list = document.querySelector(
        '[data-testid="automation-connections"] [data-slot="tabs-list"]',
      );
      const trigger = document.querySelector(
        '[data-testid="automation-connection-tab-codex"]',
      );
      const panel = document.querySelector(
        '[data-testid="automation-panel-codex"]',
      );
      if (list === null || trigger === null || panel === null) return null;

      return {
        listBottom: list.getBoundingClientRect().bottom,
        triggerBottom: trigger.getBoundingClientRect().bottom,
        panelTop: panel.getBoundingClientRect().top,
      };
    });
    expect(layout).not.toBeNull();
    expect(layout?.triggerBottom).toBeLessThanOrEqual(
      (layout?.listBottom ?? 0) + 1,
    );
    expect(layout?.panelTop).toBeGreaterThanOrEqual(layout?.listBottom ?? 0);

    await captureAutomationScreenshot("codex");
    await clickDisplayed('[data-testid="automation-connection-tab-zai"]');
    await expect($('[data-testid="automation-panel-zai"] h2')).toHaveText(
      "Z.AI",
    );
    await expect($('[data-testid="automation-observed-reset-zai"]')).toHaveText(
      "Not reported",
    );
    await expect($('[data-testid="automation-rolled-over-at-zai"]')).toHaveText(
      "Not detected",
    );
    await expect($('[data-testid="automation-last-polled-zai"]')).toHaveText(
      "Not checked",
    );
    await expect($('[data-testid="automation-next-poll-zai"]')).toHaveText(
      "Not scheduled",
    );
    await captureAutomationScreenshot("zai");
  });

  it("shows an enabled sub as Running before any click — the persisted choice", async () => {
    await bootAutomation();

    await expect($('[data-testid="automation-status-codex"]')).toHaveText(
      "Running",
    );
    await expect($('[data-testid="automation-connection-tab-zai"]')).toHaveText(
      expect.stringContaining("Stopped"),
    );
    await expect($('[data-testid="automation-toggle-codex"]')).toHaveText(
      expect.stringContaining("Stop"),
    );
    await clickDisplayed('[data-testid="automation-connection-tab-zai"]');
    await expect($('[data-testid="automation-toggle-zai"]')).toHaveText(
      expect.stringContaining("Start"),
    );
  });

  it("carries the rollover and check rows per sub with the PRD labels", async () => {
    await bootAutomation();

    // The two timestamps must each say what it is: the reset the source last
    // reported, and the moment the app detected the transition. The old label
    // ("Window reset observed at") dressed a reported value up as an observed
    // event — the exact reported-vs-observed conflation the PRD forbids.
    const rollover = $('[data-testid="automation-rollover-codex"]');
    await expect(rollover).toHaveText(
      expect.stringContaining("Last reported reset"),
    );
    await expect(rollover).toHaveText(
      expect.stringContaining("Rollover detected at"),
    );

    const schedule = $('[data-testid="automation-schedule-codex"]');
    await expect(schedule).toHaveText(expect.stringContaining("Last checked"));
    await expect(schedule).toHaveText(expect.stringContaining("Next check"));

    await clickDisplayed('[data-testid="automation-connection-tab-zai"]');
    const zaiSchedule = $('[data-testid="automation-schedule-zai"]');
    await expect(zaiSchedule).toHaveText(expect.stringContaining("Last checked"));
  });

  it("starting one sub records the choice for exactly that sub", async () => {
    await bootAutomation();

    await clickDisplayed('[data-testid="automation-connection-tab-zai"]');
    await clickDisplayed('[data-testid="automation-toggle-zai"]');

    await expect($('[data-testid="automation-status-zai"]')).toHaveText(
      "Running",
    );
    await expect($('[data-testid="automation-connection-tab-codex"]')).toHaveText(
      expect.stringContaining("Running"),
    );

    const calls = await dispatchCalls();
    const writes = calls.filter(
      (request) =>
        request.type === "startAutomation" ||
        request.type === "stopAutomation",
    );
    expect(writes).toEqual([{ type: "startAutomation", kind: "zai" }]);
  });

  it("stopping one sub leaves no trace on the other sub", async () => {
    await bootAutomation();

    await clickDisplayed('[data-testid="automation-toggle-codex"]');

    await expect($('[data-testid="automation-status-codex"]')).toHaveText(
      "Stopped",
    );

    const calls = await dispatchCalls();
    const stops = calls.filter(
      (request) =>
        request.type === "stopAutomation" && request.kind === "codex",
    );
    expect(stops.length).toBeGreaterThanOrEqual(1);
  });

  it("surfaces an unacknowledged rollover on its own sub alone", async () => {
    await bootAutomation({
      automationRunningByKind: { zai: true },
      automationRolledOver: "zai",
    });

    await clickDisplayed('[data-testid="automation-connection-tab-zai"]');

    await expect(
      $('[data-testid="automation-rolled-over-zai"]'),
    ).toHaveText("A fresh window was detected.");
    await expect($('[data-testid="automation-rolled-over-codex"]')).not.toExist();

    await clickDisplayed('[data-testid="automation-acknowledge-zai"]');

    const calls = await dispatchCalls();
    const acks = calls.filter(
      (request) =>
        request.type === "acknowledgeRollover" && request.kind === "zai",
    );
    expect(acks.length).toBeGreaterThanOrEqual(1);
  });
});
