import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, browser, $ } from "@wdio/globals";

// Repo-root `.temp/e2e`, resolved from this file so the path holds regardless
// of the working directory the runner was launched from.
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const shotDir = path.join(repoRoot, ".temp", "e2e");
// Two spec files create the same directory at load time, so the guard is an
// explicit existence check rather than `recursive: true`, which races when the
// specs are loaded in parallel.
if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });

/**
 * Harness self-test, not product coverage.
 *
 * Asserts that screenshots, the plugin bridge, mocking and window APIs work in
 * this environment. If this file fails, the harness is broken and no other
 * result in the run can be trusted.
 */
describe("E2E capability verification", () => {
  before(async () => {
    // Runs before any product mock is installed, so it observes the real app.
    // `beforeAll`-style setup here is safe because this file installs a mock
    // only inside the one test that exercises mocking, and restores it after.
    await browser.tauri.switchWindow("main");
    await browser.url("tauri://localhost");
    await $('[data-testid="dashboard"], [data-testid="onboarding"]').waitForDisplayed({
      timeout: 10_000,
    });
  });

  describe("screenshots", () => {
    it("captures the native window via saveScreenshot()", async () => {
      const file = path.join(shotDir, "native-window.png");
      const saved = await browser.saveScreenshot(file);

      expect(fs.existsSync(file)).toBe(true);
      const bytes = fs.statSync(file).size;
      // A blank/failed capture is tiny; a real render is much larger.
      expect(bytes).toBeGreaterThan(1000);
      console.log(`saveScreenshot -> ${file} (${bytes} bytes)`);
      // Returns the PNG buffer, not a boolean.
      expect(Buffer.isBuffer(saved)).toBe(true);
      expect(saved.subarray(1, 4).toString()).toBe("PNG");
    });

    it("captures a base64 payload via takeScreenshot()", async () => {
      const b64 = await browser.takeScreenshot();
      expect(typeof b64).toBe("string");
      expect(b64.length).toBeGreaterThan(1000);
      // Must be a real PNG (magic bytes), not an empty buffer.
      expect(Buffer.from(b64, "base64").subarray(1, 4).toString()).toBe("PNG");
      console.log(`takeScreenshot -> base64 length ${b64.length}`);
    });

    it("captures an individual element", async () => {
      const file = path.join(shotDir, "element-h1.png");
      const el = await $("h1");
      await el.saveScreenshot(file);
      expect(fs.statSync(file).size).toBeGreaterThan(100);
      console.log(`element screenshot -> ${file}`);
    });
  });

  describe("native window geometry", () => {
    it("reports real window dimensions (not a browser viewport)", async () => {
      const size = await browser.getWindowSize();
      const rect = await browser.getWindowRect();

      console.log("window size:", JSON.stringify(size));
      console.log("window rect:", JSON.stringify(rect));

      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
      expect(rect.x).toBeGreaterThanOrEqual(0);
    });
  });

  describe("plugin bridge", () => {
    it("reaches the Rust side through the single dispatch command", async () => {
      const result = await browser.tauri.execute(({ core }) =>
        core.invoke("dispatch", { request: { type: "hello" } }),
      );

      expect(result).toEqual({ type: "protocol", version: 1 });
      console.log("dispatch(hello) ->", JSON.stringify(result));
    });

    it("answers a usage read without touching a provider", async () => {
      // `providerStatus` only probes for the executable, so this is safe to run
      // in CI with or without Codex installed.
      const result = await browser.tauri.execute(({ core }) =>
        core.invoke("dispatch", { request: { type: "providerStatus" } }),
      );

      console.log("dispatch(providerStatus) ->", JSON.stringify(result));
      expect(result.type).toBe("providerStatuses");
      expect(Array.isArray(result.providers)).toBe(true);
    });

    it("reports onboarding progress from the real store", async () => {
      const result = await browser.tauri.execute(({ core }) =>
        core.invoke("dispatch", { request: { type: "onboardingProgress" } }),
      );

      expect(result.type).toBe("onboarding");
      // The step count is owned by Rust so the client cannot drift from it.
      expect(result.progress.total).toBe(6);
    });

    it("returns a typed failure for an over-long ping prompt", async () => {
      const result = await browser.tauri.execute(({ core }) =>
        core.invoke("dispatch", {
          request: { type: "sendPing", prompt: "x".repeat(500) },
        }),
      );

      expect(result.type).toBe("failure");
      expect(result.error.kind).toBe("invalidRequest");
    });

    it("refuses an unsupported provider at the boundary", async () => {
      // Rejected by serde before the handler runs, so the call rejects rather
      // than resolving. Either a rejection or a typed failure is correct; a
      // resolved success would mean an unknown provider slipped through.
      const outcome = await browser.tauri.execute(async ({ core }) => {
        try {
          const value = await core.invoke("dispatch", {
            request: { type: "readPlan", provider: "not-a-provider" },
          });
          return { rejected: false, value };
        } catch (error) {
          return { rejected: true, message: String(error) };
        }
      });

      expect(
        outcome.rejected ||
          (outcome.value as { type?: string } | undefined)?.type === "failure",
      ).toBe(true);
    });
  });

  describe("window management", () => {
    it("lists native windows", async () => {
      const windows = await browser.tauri.listWindows();
      console.log("listWindows ->", JSON.stringify(windows));
      expect(windows).toContain("main");
    });

    it("switches to the main window", async () => {
      await browser.tauri.switchWindow("main");
      await expect($("h1")).toBeDisplayed();
    });
  });

  describe("standard element interactions", () => {
    it("reads text, attributes and state", async () => {
      // Whichever surface happens to be up, the harness must be able to read
      // it — these assertions are about the harness, not about a screen.
      const heading = await $("h1");
      expect(await heading.isDisplayed()).toBe(true);
      expect((await heading.getText()).length).toBeGreaterThan(0);
      expect(await heading.isExisting()).toBe(true);
    });

    it("supports getProperty for DOM state", async () => {
      const value = await browser.execute(() => document.querySelector("h1")?.tagName);
      expect(value).toBe("H1");
    });

    it("reads a data attribute off a rendered element", async () => {
      const element = await $('[data-testid$="panel"], [data-testid="onboarding"]');
      expect(await element.isExisting()).toBe(true);
      expect(await element.getAttribute("data-testid")).toBeTruthy();
    });
  });

  describe("Tauri command mocking", () => {
    it("intercepts the dispatch command and asserts on call args", async () => {
      const mock = await browser.tauri.mock("dispatch");
      await mock.mockResolvedValue({ type: "protocol", version: 1 });

      const result = await browser.tauri.execute(({ core }) =>
        core.invoke("dispatch", { request: { type: "hello" } }),
      );
      expect(result).toEqual({ type: "protocol", version: 1 });

      // The whole protocol goes through one command, so the recorded call is
      // the full request envelope.
      expect(mock.mock.calls).toHaveLength(1);
      console.log("mock calls:", JSON.stringify(mock.mock.calls[0]));

      await mock.mockRestore();
    });

    it("restores the real command after mocking", async () => {
      const real = await browser.tauri.execute(({ core }) =>
        core.invoke("dispatch", { request: { type: "hello" } }),
      );
      expect(real).toEqual({ type: "protocol", version: 1 });
      console.log("after restore ->", JSON.stringify(real));
    });
  });

  after(() => {
    const shots = fs.readdirSync(shotDir);
    console.log(`\nArtifacts written to ${shotDir}:`);
    for (const f of shots) {
      console.log(`  ${f} (${fs.statSync(path.join(shotDir, f)).size} bytes)`);
    }
  });
});