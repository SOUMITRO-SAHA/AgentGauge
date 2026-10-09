import { expect, browser, $ } from "@wdio/globals";

describe("aism desktop app", () => {
  it("launches the native WKWebView window", async () => {
    // The embedded provider drives the real WKWebView, not a browser.
    const userAgent = await browser.execute(() => navigator.userAgent);
    expect(userAgent).toContain("AppleWebKit");
    expect(await browser.getUrl()).toBe("tauri://localhost");
  });

  it("renders the app shell", async () => {
    await expect($("h1")).toHaveText("Welcome to Tauri + React");
  });

  it("round-trips a Rust command end-to-end", async () => {
    await $("#greet-input").setValue("OpenCode");
    await $("button=Greet").click();

    await expect($("p=Hello, OpenCode! You've been greeted from Rust!")).toBeDisplayed();
  });
});