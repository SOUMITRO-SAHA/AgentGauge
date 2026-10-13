import { expect, browser } from "@wdio/globals";

import {
  clearSeededStores,
  clickDisplayed,
  expectDisplayed,
  gotoView,
  processScreenEnriched,
} from "../../fixtures.js";

/**
 * The process table's enriched facts: each row's CPU share with the group's
 * sum, abnormal process states, and listening endpoints that name the
 * interface they are bound to — a wildcard bind is called out as reaching
 * every interface rather than reading as one more address.
 */
after(() => {
  clearSeededStores();
});

describe("processes cpu and endpoints", () => {
  beforeEach(async () => {
    await processScreenEnriched();
  });

  it("renders each process's cpu share and the group's sum", async () => {
    await gotoView("processes");

    await expectDisplayed('[data-testid="process-panel-codex"]');
    const cpuCell = await browser.execute(
      () =>
        document.querySelector('[data-testid="process-cpu-4242"]')
          ?.textContent ?? "",
    );
    expect(cpuCell).toBe("12.5%");
    await expect(
      $('[data-testid="process-totals-codex"]'),
    ).toHaveText(expect.stringContaining("12.5%"));
  });

  it("tags abnormal process states and leaves normal rows untagged", async () => {
    await gotoView("processes");

    await expectDisplayed('[data-testid="process-status-4243"]');
    await expect($('[data-testid="process-status-4243"]')).toHaveText(
      "zombie",
    );
    expect(
      await browser.execute(
        () =>
          document.querySelector('[data-testid="process-status-4242"]') ===
          null,
      ),
    ).toBe(true);
  });

  it("names each endpoint's interface and calls out wildcard binds", async () => {
    await gotoView("processes");
    await clickDisplayed('[data-testid="process-tab-opencode"]');
    await expectDisplayed('[data-testid="process-panel-opencode"]');

    const endpoints = await browser.execute(
      () =>
        document.querySelector('[data-testid="process-ports-5309"]')
          ?.textContent ?? "",
    );
    expect(endpoints).toBe("*:4096 127.0.0.1:49374");

    await expect(
      $('[data-testid="process-totals-opencode"]'),
    ).toHaveText(expect.stringContaining("127.0.0.1:49374"));
    await expect(
      $('[data-testid="process-totals-opencode"]'),
    ).toHaveText(expect.stringContaining("*:4096 · all interfaces"));
  });
});
