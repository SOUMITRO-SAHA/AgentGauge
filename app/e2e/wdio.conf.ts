import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Built by `bun run e2e:build`. Must be built with `--features custom-protocol`
// so the binary embeds frontendDist and does not need a running Vite dev server.
const appBinaryPath = path.resolve(
  here,
  "..",
  "src-tauri/target/debug/aism",
);

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: [path.join(here, "specs", "**", "*.e2e.ts")],
  maxInstances: 1,
  logLevel: "info",
  bail: 0,
  waitforTimeout: 10_000,
  connectionRetryTimeout: 120_000,
  framework: "mocha",
  reporters: ["spec"],

  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath,
        // 'embedded' runs a WebDriver server inside the app itself (via
        // tauri-plugin-wdio-webdriver). This is the only provider that works
        // on macOS without a paid CrabNebula key, and needs no external driver
        // on Windows/Linux either.
        driverProvider: "embedded",
      },
    ],
  ],

  capabilities: [
    {
      browserName: "wry",
      "tauri:options": {
        application: appBinaryPath,
      },
    },
  ],

  mochaOpts: {
    ui: "bdd",
    timeout: 60_000,
  },
};