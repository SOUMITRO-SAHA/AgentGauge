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
fs.mkdirSync(shotDir, { recursive: true });

describe("E2E capability verification", () => {
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

      // tauri.conf.json declares 800x600.
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
      expect(rect.x).toBeGreaterThanOrEqual(0);
    });
  });

  describe("browser.tauri.execute() plugin bridge", () => {
    it("runs JS with access to the Tauri API", async () => {
      const result = await browser.tauri.execute(({ core }) =>
        core.invoke("greet", { name: "PluginBridge" }),
      );
      expect(result).toBe("Hello, PluginBridge! You've been greeted from Rust!");
      console.log("tauri.execute invoke ->", result);
    });

    it("passes arguments through the bridge", async () => {
      const result = await browser.tauri.execute(
        ({ core }, name: string) => core.invoke("greet", { name }),
        "ArgTest",
      );
      expect(result).toContain("ArgTest");
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
      const h1 = await $("h1");
      expect(await h1.getText()).toBe("Welcome to Tauri + React");
      expect(await h1.isDisplayed()).toBe(true);
      expect(await h1.isExisting()).toBe(true);

      const input = await $("#greet-input");
      expect(await input.getAttribute("placeholder")).toBe("Enter a name...");
    });

    it("types with setValue and clearValue", async () => {
      const input = await $("#greet-input");
      await input.setValue("First");
      expect(await input.getValue()).toBe("First");
      await input.clearValue();
      expect(await input.getValue()).toBe("");
    });

    it("types with individual key presses", async () => {
      const input = await $("#greet-input");
      await input.click();
      await browser.keys(["A", "B", "C"]);
      expect(await input.getValue()).toBe("ABC");
    });

    it("waits for an element to appear", async () => {
      const el = await $("button=Greet");
      await el.waitForDisplayed({ timeout: 5000 });
      expect(await el.isDisplayed()).toBe(true);
    });

    it("supports getProperty for DOM state", async () => {
      const value = await browser.execute(() => document.querySelector("h1")?.tagName);
      expect(value).toBe("H1");
    });
  });

  describe("Tauri command mocking", () => {
    it("intercepts a Rust command and asserts on call args", async () => {
      const mock = await browser.tauri.mock("greet");
      await mock.mockResolvedValue("MOCKED greeting");

      const result = await browser.tauri.execute(({ core }) =>
        core.invoke("greet", { name: "Mocked" }),
      );
      expect(result).toBe("MOCKED greeting");

      expect(mock.mock.calls).toHaveLength(1);
      console.log("mock calls:", JSON.stringify(mock.mock.calls[0]));

      await mock.mockRestore();
    });

    it("restores the real command after mocking", async () => {
      const real = await browser.tauri.execute(({ core }) =>
        core.invoke("greet", { name: "Real" }),
      );
      expect(real).toBe("Hello, Real! You've been greeted from Rust!");
      console.log("after restore ->", real);
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