import { expect, $ } from "@wdio/globals";

import {
  dashboardLive,
  gotoView,
  restoreOnboardingStore,
} from "../fixtures.js";

/**
 * The Automation view: the rollover monitor and the schedule around it.
 *
 * Runs in the single ordered group configured in `wdio.conf.ts`; the harness
 * rules that make that work live in `../fixtures.ts`. The persisted stores are
 * restored at *file* scope, which is the only place mocha runs an `after`
 * after every `describe` here has finished.
 */
after(() => {
  restoreOnboardingStore();
});

describe("automation", () => {
  beforeEach(async () => {
    await dashboardLive();
  });

  it("reports the rollover monitor with the PRD framing", async () => {
    // The monitor moved to its own destination with the navigation.
    await gotoView("automation");
    await expect($('[data-testid="automation-status"]')).toHaveText("Running");

    // Named for the PRD's own capability ("rollover detection"), which the
    // Rust core implements as the verified rollover detector — not "window
    // watcher", a term the PRD does not use.
    await expect($('[data-testid="automation-panel"] h2')).toHaveText(
      "Rollover monitor",
    );

    // The two timestamps must each say what it is: the reset the source last
    // reported, and the moment the app detected the transition. The old label
    // ("Window reset observed at") dressed a reported value up as an observed
    // event — the exact reported-vs-observed conflation the PRD forbids.
    const rollover = $('[data-testid="automation-rollover"]');
    await expect(rollover).toHaveText(
      expect.stringContaining("Last reported reset"),
    );
    await expect(rollover).toHaveText(
      expect.stringContaining("Rollover detected at"),
    );

    const schedule = $('[data-testid="automation-schedule"]');
    await expect(schedule).toHaveText(expect.stringContaining("Last checked"));
    await expect(schedule).toHaveText(expect.stringContaining("Next check"));
  });
});
