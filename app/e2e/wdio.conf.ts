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
  // Every spec file drives the SAME renderer, because the app is a single
  // window. A `tauri.mock()` installed by one file therefore replaces the one
  // the previous file installed, and running files concurrently makes the
  // fixtures race — a spec would assert against whichever file installed last.
  //
  // Running them in one worker keeps each file's setup and assertions adjacent,
  // so `mock()` in a `beforeEach` is only in effect for that file's tests.
  specFileRetries: 0,
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