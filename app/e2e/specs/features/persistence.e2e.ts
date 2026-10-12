import fs from "node:fs";
import path from "node:path";
import { expect, browser, $ } from "@wdio/globals";

import { E2E_DATA_DIR } from "../../data-dir.js";
import {
  clickDisplayed,
  expectDisplayed,
  firstDisplayed,
  installDispatch,
  liveSnapshot,
  openApp,
  pollForDisplayed,
  clearSeededStores,
  seedOnboardingStep,
  seedRoute,
} from "../fixtures.js";

/**
 * The persistence contract, against the real binary and its real database.
 *
 * The gate lives in Rust (`OnboardingProgress.visible`), the state lives in a
 * SQLite database inside the sandbox data directory, and a pre-database JSON
 * file is imported exactly once. These specs walk that whole path — seed,
 * boot, import, render, write, re-read — instead of mocking the dispatch,
 * because "onboarding must not restart on a cold start" is precisely the kind
 * of promise a mock cannot test.
 */
describe("persistence", () => {
  const dbPath = path.join(E2E_DATA_DIR, "agentgauge.db");
  const legacyPath = path.join(E2E_DATA_DIR, "onboarding.json");

  after(() => {
    clearSeededStores();
  });

  it("imports a pre-database mid-flow file and resumes at that step", async () => {
    seedOnboardingStep("widget", false);
    seedRoute("home");

    await openApp();

    // The mount-time read hits the real store: the seed is imported, the flow
    // opens, and progress resumes where the imported file left it — not at
    // the first step.
    await expectDisplayed('[data-testid="onboarding"]');
    await expect($('[data-testid="onboarding"] h1')).toHaveText(
      "Keep usage in sight",
    );

    // The import consumed the legacy file, so it can never replay over newer
    // state, and the database file exists where every later boot reads it.
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(`${legacyPath}.imported`)).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);

    await installDispatch({
      visible: true,
      usage: liveSnapshot(),
      installed: true,
      version: "codex-cli 0.159.0",
      widgetEmbedded: true,
      widgetSupported: true,
      automationRunning: true,
    });
  });

  it("keeps completed onboarding hidden after a renderer reload", async () => {
    // The mock absorbs writes, so remove it: the Skip click must travel the
    // real client -> server -> database path for this assertion to mean
    // anything.
    await browser.execute(() => {
      const w = window as unknown as {
        __wdio_mocks__?: Record<string, unknown>;
      };
      delete w.__wdio_mocks__?.dispatch;
    });

    if (!(await firstDisplayed('[data-testid="onboarding"]'))) {
      throw new Error("the flow should still be showing for this spec");
    }
    await clickDisplayed('[data-testid="onboarding-skip"]');

    // Poll the real command: the write is durable only once the stored state
    // answers dismissed.
    for (let waited = 0; waited < 10_000; waited += 250) {
      const result = (await browser.tauri.execute(({ core }) =>
        core.invoke("dispatch", { request: { type: "onboardingProgress" } }),
      )) as { progress?: { visible?: boolean } } | null;
      if (result?.progress?.visible === false) break;
      await browser.pause(250);
    }
    const stored = (await browser.tauri.execute(({ core }) =>
      core.invoke("dispatch", { request: { type: "onboardingProgress" } }),
    )) as { progress?: { visible?: boolean; dismissed?: boolean } } | null;
    expect(stored?.progress?.visible).toBe(false);
    expect(stored?.progress?.dismissed).toBe(true);

    // A renderer cold start re-asks the store from scratch: the gate must
    // still answer hidden, because the answer lives in the database, not in
    // the session.
    await browser.url("tauri://localhost");
    await pollForDisplayed('[data-testid="app-shell"]', 15_000);
    await expectDisplayed('[data-testid="app-shell"]');
    expect(await $('[data-testid="onboarding"]').isDisplayed()).toBe(false);
  });
});
