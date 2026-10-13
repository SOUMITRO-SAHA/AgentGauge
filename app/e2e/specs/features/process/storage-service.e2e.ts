import { expect, browser } from "@wdio/globals";

import {
  clearSeededStores,
  clickDisplayed,
  expectDisplayed,
  gotoView,
  processScreenEnriched,
} from "../../fixtures.js";

/**
 * The storage breakdown's enriched facts: the components the tools actually
 * create (the git snapshot directory among them), a share bar scaled to each
 * row's fraction of the measured total, relocated footprint carried outside
 * that total, and the tool's self-recorded background service attached to a
 * live pid.
 */

/** Codex's row count once the enriched report has rendered. */
const CODEX_ROWS = 4;

async function awaitEnrichedStorage(): Promise<void> {
  await gotoView("processes");
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        () =>
          document.querySelectorAll(
            '[data-testid="process-storage-row-codex"]',
          ).length,
      )) === CODEX_ROWS,
    { timeout: 15_000 },
  );
}

after(() => {
  clearSeededStores();
});

describe("processes storage and service", () => {
  beforeEach(async () => {
    await processScreenEnriched();
  });

  it("labels the real components the tools create", async () => {
    await awaitEnrichedStorage();

    await expectDisplayed('[data-testid="process-tab-opencode"]');
    await clickDisplayed('[data-testid="process-tab-opencode"]');
    await expectDisplayed('[data-testid="process-storage-opencode"]');
    await expect($('[data-testid="process-storage-opencode"]')).toHaveText(
      expect.stringContaining("Project snapshots (git)"),
    );

    await clickDisplayed('[data-testid="process-tab-codex"]');
    await expectDisplayed('[data-testid="process-storage-codex"]');
    await expect($('[data-testid="process-storage-codex"]')).toHaveText(
      expect.stringContaining("Databases (SQLite)"),
    );
  });

  it("scales a share bar to each row's fraction of the measured total", async () => {
    await awaitEnrichedStorage();

    const shares = await browser.execute(() =>
      Array.from(
        document.querySelectorAll(
          '[data-testid="process-storage-share-codex"]',
        ),
      ).map((bar) => (bar as HTMLElement).style.width),
    );
    expect(shares).toEqual(["55%", "30%", "15%"]);
  });

  it("carries relocated footprint outside the measured total", async () => {
    await awaitEnrichedStorage();

    await expectDisplayed('[data-testid="process-storage-external-codex"]');
    const external = await $(
      '[data-testid="process-storage-external-codex"]',
    ).getText();
    expect(external).toContain("Outside the data directory");
    expect(external).toContain("relocated via CODEX_SQLITE_HOME");
    expect(external).toContain("120 MB");

    const totals = await $('[data-testid="process-totals-codex"]').getText();
    expect(totals).toContain("1 GB");
    expect(totals).not.toContain("1.1 GB");
  });

  it("renders the tool's recorded background service with its live pid", async () => {
    await awaitEnrichedStorage();
    await clickDisplayed('[data-testid="process-tab-opencode"]');
    await expectDisplayed('[data-testid="process-panel-opencode"]');

    await expectDisplayed('[data-testid="process-service-opencode"]');
    await expect($('[data-testid="process-service-opencode"]')).toHaveText(
      "Background service · v2.0.27 · http://127.0.0.1:49374",
    );
    expect(
      await browser.execute(
        () =>
          document.querySelector('[data-testid="process-service-codex"]') ===
          null,
      ),
    ).toBe(true);
  });
});
