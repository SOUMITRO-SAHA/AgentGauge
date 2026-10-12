import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, browser } from "@wdio/globals";

import {
  clearSeededStores,
  expectDisplayed,
  gotoView,
  processScreenWithPorts,
} from "../../fixtures.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);

after(() => {
  clearSeededStores();
});

describe("responsive Processes table", () => {
  beforeEach(async () => {
    await processScreenWithPorts();
  });

  it("fits the minimum window without horizontal scrolling or hiding process facts", async () => {
    const originalSize = await browser.getWindowSize();

    try {
      await gotoView("processes");
      await expectDisplayed('[data-testid="process-row-5309"]');
      await browser.setWindowSize(360, 720);
      await browser.pause(300);
      await expectDisplayed('[data-testid="process-details-5309"]');

      const layout = await browser.execute(() => {
        const documentElement = document.documentElement;
        const table = document
          .querySelector('[data-testid="process-row-5309"]')
          ?.closest("table");
        const tableContainer = table?.parentElement;
        const panel = document.querySelector(
          '[data-testid="process-panel-opencode"]',
        );
        const details = document.querySelector(
          '[data-testid="process-details-5309"]',
        );

        return {
          documentOverflow:
            documentElement.scrollWidth - documentElement.clientWidth,
          tableOverflow: tableContainer
            ? tableContainer.scrollWidth - tableContainer.clientWidth
            : null,
          panelOverflow: panel
            ? panel.getBoundingClientRect().right - window.innerWidth
            : null,
          detailsVisible: details
            ? getComputedStyle(details).display !== "none" &&
              details.getBoundingClientRect().width > 0
            : false,
          detailsText: details?.textContent ?? "",
          storageRows: Array.from(
            document.querySelectorAll(
              '[data-testid="process-storage-row-codex"]',
            ),
          ).flatMap((row) => {
            const left = row.firstElementChild;
            const value = row.querySelector(
              '[data-testid="process-storage-value-codex"]',
            );
            if (!left || !value) return [];
            const rowRect = row.getBoundingClientRect();
            const leftRect = left.getBoundingClientRect();
            const valueRect = value.getBoundingClientRect();
            return [
              {
                leftWidthRatio: leftRect.width / rowRect.width,
                leftRight: leftRect.right,
                valueLeft: valueRect.left,
                valueRight: valueRect.right,
                rowRight: rowRect.right,
              },
            ];
          }),
        };
      });

      expect(layout.documentOverflow).toBeLessThanOrEqual(1);
      expect(layout.tableOverflow).not.toBeNull();
      expect(layout.tableOverflow as number).toBeLessThanOrEqual(1);
      expect(layout.panelOverflow).not.toBeNull();
      expect(layout.panelOverflow as number).toBeLessThanOrEqual(1);
      expect(layout.detailsVisible).toBe(true);
      expect(layout.detailsText).toContain("PID 5309");
      expect(layout.detailsText).toContain(":49374");
      expect(layout.detailsText).toContain("Uptime");
      expect(layout.storageRows).toHaveLength(3);
      for (const row of layout.storageRows) {
        expect(row.leftWidthRatio).toBeLessThanOrEqual(0.71);
        expect(row.leftRight).toBeLessThanOrEqual(row.valueLeft);
        expect(Math.abs(row.rowRight - row.valueRight)).toBeLessThanOrEqual(1);
      }

      const screenshotDirectory = path.join(repoRoot, ".temp", "screenshots");
      const screenshotPath = path.join(
        screenshotDirectory,
        "processes-responsive-360.png",
      );
      fs.mkdirSync(screenshotDirectory, { recursive: true });
      const screenshot = await browser.saveScreenshot(screenshotPath);
      expect(screenshot.subarray(1, 4).toString()).toBe("PNG");
      expect(fs.statSync(screenshotPath).size).toBeGreaterThan(1000);
    } finally {
      await browser.setWindowSize(originalSize.width, originalSize.height);
    }
  });
});
