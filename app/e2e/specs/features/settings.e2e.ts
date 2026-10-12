import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, browser, $ } from "@wdio/globals";

import {
  clearSeededStores,
  dashboardLive,
  expectDisplayed,
  gotoView,
} from "../fixtures.js";

const screenshots = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.temp/screenshots",
);

after(() => {
  clearSeededStores();
});

describe("settings", () => {
  it("presents build identity, feedback, widget guidance, and the $1 support action", async () => {
    await dashboardLive();
    await gotoView("settings");

    await expectDisplayed('[data-testid="about-version"]');
    await expect($('[data-testid="about-version"]')).toHaveText(
      expect.stringMatching(/^v\d+\.\d+\.\d+/),
    );
    await expectDisplayed('[data-testid="feedback-bug"]');
    await expectDisplayed('[data-testid="feedback-feature"]');
    await expectDisplayed('[data-testid="widget-status"]');
    await expect($('[data-testid="support-message"]')).toHaveText(
      expect.stringContaining("$1"),
    );
    await expect($('[data-testid="support-link-github-sponsors"]')).toHaveText(
      expect.stringContaining("Sponsor from $1"),
    );
    await expectDisplayed('[data-testid="support-link-patreon"]');

    const brand = await browser.execute(() => {
      const sidebar = document.querySelector(
        '[data-testid="app-shell"] [data-testid="brand-mark"]',
      );
      const about = document.querySelector('[data-testid="about-mark"] svg');
      const container = document.querySelector('[data-testid="about-mark"]');
      if (!sidebar || !about || !container) return null;
      return {
        sidebarColour: getComputedStyle(sidebar).color,
        aboutColour: getComputedStyle(about).color,
        aboutBackground: getComputedStyle(container).backgroundColor,
      };
    });
    expect(brand).not.toBeNull();
    expect(brand?.aboutColour).toBe(brand?.sidebarColour);
    expect(brand?.aboutBackground).toBe("rgba(0, 0, 0, 0)");

    const layout = await browser.execute(() => {
      const panel = (id: string) =>
        document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
      const about = panel("about-panel");
      const feedback = panel("feedback-panel");
      const widget = panel("widget-panel");
      const support = panel("support-panel");
      if (!about || !feedback || !widget || !support) return null;
      return {
        paired: Math.abs(about.top - feedback.top) < 1,
        alignedBottom: Math.abs(about.bottom - feedback.bottom) < 1,
        width: window.innerWidth,
        widgetBelowPair: widget.top >= Math.max(about.bottom, feedback.bottom),
        supportAfterWidget: support.top >= widget.bottom,
        noHorizontalOverflow:
          document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      };
    });

    expect(layout).not.toBeNull();
    if (layout && layout.width >= 768) {
      expect(layout.paired).toBe(true);
      expect(layout.alignedBottom).toBe(true);
    }
    expect(layout?.widgetBelowPair).toBe(true);
    expect(layout?.supportAfterWidget).toBe(true);
    expect(layout?.noHorizontalOverflow).toBe(true);

    fs.mkdirSync(screenshots, { recursive: true });
    const top = path.join(screenshots, "settings-top.png");
    await browser.saveScreenshot(top);
    expect(fs.statSync(top).size).toBeGreaterThan(1000);
    await $('[data-testid="support-panel"]').scrollIntoView();
    const bottom = path.join(screenshots, "settings-support.png");
    await browser.saveScreenshot(bottom);
    expect(fs.statSync(bottom).size).toBeGreaterThan(1000);

    const originalSize = await browser.getWindowSize();
    try {
      await browser.setWindowSize(500, 700);
      const narrow = await browser.execute(() => {
        const about = document.querySelector('[data-testid="about-panel"]');
        const feedback = document.querySelector('[data-testid="feedback-panel"]');
        if (!about || !feedback) return null;
        return {
          width: window.innerWidth,
          stacked:
            feedback.getBoundingClientRect().top >=
            about.getBoundingClientRect().bottom,
          noHorizontalOverflow:
            document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        };
      });
      expect(narrow?.width).toBeLessThan(768);
      expect(narrow?.stacked).toBe(true);
      expect(narrow?.noHorizontalOverflow).toBe(true);
      await browser.execute(() => {
        document.querySelector('[data-testid="view-settings"]')?.scrollIntoView({
          block: "start",
        });
      });
      const smallTop = path.join(screenshots, "settings-narrow-top.png");
      await browser.saveScreenshot(smallTop);
      expect(fs.statSync(smallTop).size).toBeGreaterThan(1000);
      await $('[data-testid="support-link-github-sponsors"]').scrollIntoView();
      const sponsorUnobscured = await browser.execute(() => {
        const button = document.querySelector(
          '[data-testid="support-link-github-sponsors"]',
        );
        if (!button) return false;
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return hit !== null && button.contains(hit);
      });
      expect(sponsorUnobscured).toBe(true);
      const smallSupport = path.join(screenshots, "settings-narrow-support.png");
      await browser.saveScreenshot(smallSupport);
      expect(fs.statSync(smallSupport).size).toBeGreaterThan(1000);
    } finally {
      await browser.setWindowSize(originalSize.width, originalSize.height);
    }
  });
});
