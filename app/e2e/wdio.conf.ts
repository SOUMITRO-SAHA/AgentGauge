import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { E2E_DATA_DIR } from "./data-dir.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Built by `bun run e2e:build`. Must be built with `--features custom-protocol`
// so the binary embeds frontendDist and does not need a running Vite dev server.
const appBinaryPath = path.resolve(
  here,
  "..",
  "src-tauri/target/debug/agentgauge",
);

export const config: WebdriverIO.Config = {
  runner: "local",
  // One *group*, not a glob: a grouped array runs in a single worker instance,
  // in order. A glob lets wdio run files as parallel instances, and every file
  // drives the SAME renderer — parallel files raced each other's mocks and
  // boots (verified: product boots failed while capabilities ran alongside).
  //
  // `specs/features/` holds one file per feature so `--spec` can run a single
  // task's coverage. Those files stay in this one group, in this order: they
  // share the renderer and the persisted stores, so running them as separate
  // instances would race exactly as a glob does.
  //
  // capabilities first: it probes the harness itself, not fixtures.
  specs: [
    [
      path.join(here, "specs", "capabilities.e2e.ts"),
      path.join(here, "specs", "features", "onboarding.e2e.ts"),
      path.join(here, "specs", "features", "persistence.e2e.ts"),
      path.join(here, "specs", "features", "dashboard.e2e.ts"),
      path.join(here, "specs", "features", "usage-tabs.e2e.ts"),
      path.join(here, "specs", "features", "kickoff.e2e.ts"),
      path.join(here, "specs", "features", "automation.e2e.ts"),
      path.join(here, "specs", "features", "widget.e2e.ts"),
      path.join(here, "specs", "features", "styling.e2e.ts"),
      path.join(here, "specs", "features", "stats.e2e.ts"),
      path.join(here, "specs", "features", "process.e2e.ts"),
      path.join(here, "specs", "features", "navigation.e2e.ts"),
      path.join(here, "specs", "features", "sidebar-collapse.e2e.ts"),
      path.join(here, "specs", "features", "dev-test-screen.e2e.ts"),
      path.join(here, "specs", "onboarding-visual.e2e.ts"),
    ],
  ],
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

  onPrepare() {
    // A pristine sandbox per run: the app boots into an empty data directory,
    // so each run's first boot is a genuine first run. The fixtures then seed
    // the gate per spec through the same legacy-import path a real install
    // upgrades through.
    fs.rmSync(E2E_DATA_DIR, { recursive: true, force: true });
  },

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
        // Redirect the app's data directory into the sandbox. The service
        // merges these into the spawned process's environment.
        env: { AGENTGAUGE_DATA_DIR: E2E_DATA_DIR },
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
    // Generous: a boot waits for the native window, remounts the app, settles
    // the mount-time read, then nudges every atom twice — measured past 60s on
    // a cold start. The default cut specs off mid-boot and every later spec in
    // the file then failed behind it.
    timeout: 150_000,
  },
};
