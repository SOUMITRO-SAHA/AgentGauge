import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, browser } from "@wdio/globals";

import {
  clearSeededStores,
  dashboardLive,
  expectDisplayed,
} from "../fixtures.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

after(() => {
  clearSeededStores();
});

describe("CLI executable discovery", () => {
  beforeEach(async () => {
    await dashboardLive();
  });

  it("keeps resolved executable paths out of the rendered UI", async () => {
    await expectDisplayed('[data-testid="codex-version"]');
    await expectDisplayed('[data-testid="opencode-version"]');
    const markup = await browser.execute(() => document.body.innerHTML);
    expect(markup).not.toContain("/Users/test/.local/bin/codex");
    expect(markup).not.toContain("/Users/test/.opencode/bin/opencode");
    const screenshotPath = path.join(
      repoRoot,
      ".temp",
      "screenshots",
      "cli-path-visibility.png",
    );
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await browser.saveScreenshot(screenshotPath);
    expect(fs.statSync(screenshotPath).size).toBeGreaterThan(1000);
  });

  it("does not show resolved executable paths when version checks fail", async () => {
    await dashboardLive({ cliDetectionFailure: true });
    await expectDisplayed('[data-testid="cli-codex"]');
    await expectDisplayed('[data-testid="cli-opencode"]');
    const markup = await browser.execute(() => document.body.innerHTML);
    expect(markup).not.toContain("/Users/test/.local/bin/codex");
    expect(markup).not.toContain("/Users/test/.opencode/bin/opencode");
  });
});
