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

after(() => {
  clearSeededStores();
});

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

async function captureScreenshot(name: string): Promise<void> {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );
  const directory = path.join(repoRoot, ".temp", "screenshots");
  const file = path.join(directory, `automation-${name}.png`);
  fs.mkdirSync(directory, { recursive: true });
  const screenshot = await browser.saveScreenshot(file);
  expect(screenshot.subarray(1, 4).toString()).toBe("PNG");
  expect(fs.statSync(file).size).toBeGreaterThan(1000);
}

describe("automation", () => {
  it("shows connection tabs with correct active/inactive status", async () => {
    await bootAutomation({
      kickoff: { enabledByKind: { codex: true } },
    });

    const codexTab = $('[data-testid="automation-connection-tab-codex"]');
    const zaiTab = $('[data-testid="automation-connection-tab-zai"]');
    await expect(codexTab).toHaveText(expect.stringContaining("Codex"));
    await expect(codexTab).toHaveText(expect.stringContaining("Active"));
    await expect(zaiTab).toHaveText(expect.stringContaining("Z.AI"));
    await expect(zaiTab).toHaveText(expect.stringContaining("Inactive"));

    await expect(
      $('[data-testid="automation-panel-codex"] h2'),
    ).toHaveText("Codex");
    await expect(
      $('[data-testid="automation-panel-zai"]'),
    ).not.toExist();

    expect(
      await $$('[data-testid="automation-loading-skeleton"]'),
    ).toHaveLength(0);

    await captureScreenshot("codex");
  });

  it("displays the command preview and allows copying", async () => {
    await bootAutomation();

    const command = $('[data-testid="automation-command-codex"]');
    await expect(command).toExist();
    const text = await command.getText();
    expect(text).toContain("codex exec");
    expect(text).toContain('"Hi"');
    expect(text).toContain("--model");
    expect(text).toContain("-s read-only");
    expect(text).toContain("--ephemeral");

    await expect(
      $('[data-testid="automation-copy-codex"]'),
    ).toBeDisplayed();

    await clickDisplayed('[data-testid="automation-connection-tab-zai"]');
    const zaiCommand = $('[data-testid="automation-command-zai"]');
    await expect(zaiCommand).toExist();
    const zaiText = await zaiCommand.getText();
    expect(zaiText).toContain("opencode run");
    expect(zaiText).toContain('"Hi"');
    expect(zaiText).toContain("zai-coding-plan");

    await captureScreenshot("zai-command");
  });

  it("updates the command preview when model or effort changes", async () => {
    await bootAutomation();

    const commandBefore = await browser.execute(() => {
      const el = document.querySelector(
        '[data-testid="automation-command-codex"] code',
      );
      return el?.textContent ?? "";
    });
    expect(commandBefore).toContain("gpt-6-luna");

    await clickDisplayed('[data-testid="kickoff-model-codex"]');
    const trigger = $('[data-testid="kickoff-model-codex"]');
    await trigger.click();
    await browser.keys(["ArrowUp", "Enter"]);

    const commandAfter = await browser.execute(() => {
      const el = document.querySelector(
        '[data-testid="automation-command-codex"] code',
      );
      return el?.textContent ?? "";
    });
    expect(commandAfter).toContain("gpt-6.1-sol");

    const calls = await dispatchCalls();
    const modelWrites = calls.filter(
      (request) => request.type === "setKickoffModel",
    );
    expect(modelWrites.length).toBeGreaterThanOrEqual(1);
    expect(modelWrites[0]).toHaveProperty("modelId", "gpt-6.1-sol");
  });

  it("shows a single Start button that fires both monitor and kickoff", async () => {
    await bootAutomation({ automationRunning: false });

    const toggle = $('[data-testid="automation-toggle-codex"]');
    await expect(toggle).toHaveText(expect.stringContaining("Start Automation"));

    await clickDisplayed('[data-testid="automation-toggle-codex"]');

    const calls = await dispatchCalls();
    const starts = calls.filter(
      (request) => request.type === "startAutomation" && request.kind === "codex",
    );
    const enables = calls.filter(
      (request) => request.type === "setKickoffEnabled" && request.kind === "codex" && request.enabled === true,
    );
    expect(starts.length).toBeGreaterThanOrEqual(1);
    expect(enables.length).toBeGreaterThanOrEqual(1);
  });

  it("locks model and effort selectors while automation is active", async () => {
    await bootAutomation({
      kickoff: { enabledByKind: { codex: true } },
    });

    const toggle = $('[data-testid="automation-toggle-codex"]');
    await expect(toggle).toHaveText(expect.stringContaining("Stop Automation"));

    const modelDisabled = await browser.execute(() => {
      const el = document.querySelector(
        '[data-testid="kickoff-model-codex"]',
      );
      return el?.hasAttribute("data-disabled") ||
        el?.getAttribute("aria-disabled") === "true" ||
        (el as HTMLButtonElement)?.disabled === true;
    });
    expect(modelDisabled).toBe(true);

    const effortDisabled = await browser.execute(() => {
      const el = document.querySelector(
        '[data-testid="kickoff-effort-codex"]',
      );
      return el?.hasAttribute("data-disabled") ||
        el?.getAttribute("aria-disabled") === "true" ||
        (el as HTMLButtonElement)?.disabled === true;
    });
    expect(effortDisabled).toBe(true);
  });

  it("shows status section only while active", async () => {
    await bootAutomation({
      kickoff: { enabledByKind: { codex: true } },
    });

    await expect(
      $('[data-testid="automation-next-codex"]'),
    ).toBeDisplayed();
    await expect(
      $('[data-testid="automation-observed-reset-codex"]'),
    ).toBeDisplayed();

    await clickDisplayed('[data-testid="automation-connection-tab-zai"]');
    await expect(
      $('[data-testid="automation-next-zai"]'),
    ).not.toExist();
  });

  it("stopping fires both disable-kickoff and stop-automation", async () => {
    await bootAutomation({
      kickoff: { enabledByKind: { codex: true } },
    });

    const callsBefore = await dispatchCalls();
    const countBefore = callsBefore.length;

    await clickDisplayed('[data-testid="automation-toggle-codex"]');

    await browser.waitUntil(
      async () => {
        const tab = $('[data-testid="automation-connection-tab-codex"]');
        const text = await tab.getText();
        return text.includes("Inactive");
      },
      { timeout: 10_000, timeoutMsg: "Tab did not switch to Inactive" },
    );

    const allCalls = await dispatchCalls();
    const newCalls = allCalls.slice(countBefore);
    const disables = newCalls.filter(
      (request) =>
        request.type === "setKickoffEnabled" &&
        request.kind === "codex" &&
        request.enabled === false,
    );
    const stops = newCalls.filter(
      (request) =>
        request.type === "stopAutomation" && request.kind === "codex",
    );
    expect(disables.length).toBeGreaterThanOrEqual(1);
    expect(stops.length).toBeGreaterThanOrEqual(1);
  });
});
