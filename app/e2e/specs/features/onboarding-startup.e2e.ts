import { expect, browser, $ } from "@wdio/globals";

import { expectDisplayed, openApp } from "../fixtures.js";

describe("returning-user startup", () => {
  it("opens the app shell without onboarding for a completed profile", async () => {
    await openApp();

    await expectDisplayed('[data-testid="app-shell"]');

    const progress = (await browser.tauri.execute(({ core }) =>
      core.invoke("dispatch", { request: { type: "onboardingProgress" } }),
    )) as { progress?: { visible?: boolean } };
    expect(progress.progress?.visible).toBe(false);

    await browser.execute(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(await $('[data-testid="onboarding"]').isDisplayed()).toBe(false);
  });
});
