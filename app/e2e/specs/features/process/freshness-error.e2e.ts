import { expect, browser } from "@wdio/globals";

import {
  clearSeededStores,
  expectDisplayed,
  gotoView,
  processScreenEnriched,
  processScreenFailed,
} from "../../fixtures.js";

/**
 * The reading's own metadata and the failed read: when the snapshot was
 * taken and what it covers across groups, the footnote that explains CPU
 * above one hundred percent, and an error state that carries its own reason
 * with the one action that is allowed everywhere on this screen — reading
 * again.
 */
after(() => {
  clearSeededStores();
});

describe("processes reading metadata", () => {
  beforeEach(async () => {
    await processScreenEnriched();
  });

  it("marks when the reading was taken and what it covers", async () => {
    await gotoView("processes");

    await expectDisplayed('[data-testid="process-meta"]');
    const pill = await $('[data-testid="process-meta"] [data-testid="freshness-pill"]');
    await expect(pill).toHaveText(expect.stringContaining("Read just now"));
    expect(
      await pill.getAttribute("data-freshness"),
    ).toBe("live");

    await expect($('[data-testid="process-summary"]')).toHaveText(
      expect.stringContaining("2 groups"),
    );
    await expect($('[data-testid="process-summary"]')).toHaveText(
      expect.stringContaining("3 processes"),
    );
    await expect($('[data-testid="process-summary"]')).toHaveText(
      expect.stringContaining("732 MB memory"),
    );
    await expect($('[data-testid="process-summary"]')).toHaveText(
      expect.stringContaining("1.9 GB on disk"),
    );
  });

  it("explains cpu above one hundred percent in the read-only note", async () => {
    await gotoView("processes");

    await expect($('[data-testid="process-readonly-note"]')).toHaveText(
      expect.stringContaining("100%"),
    );
  });
});

describe("processes failed read", () => {
  beforeEach(async () => {
    await processScreenFailed();
  });

  it("shows the read's own reason and offers the re-read", async () => {
    await gotoView("processes");

    await expectDisplayed('[data-testid="process-error"]');
    await expect($('[data-testid="process-error"]')).toHaveText(
      expect.stringContaining("the process table was unreadable"),
    );
    await expectDisplayed('[data-testid="retry-processes"]');

    expect(
      await browser.execute(
        () =>
          Array.from(
            document.querySelectorAll('[data-testid="process-error"] button'),
          ).every((button) =>
            button.getAttribute("data-testid")?.startsWith("retry-processes"),
          ),
      ),
    ).toBe(true);
  });
});
