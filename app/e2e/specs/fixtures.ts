import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, browser, $, $$ } from "@wdio/globals";

/**
 * Shared fixtures for the dashboard specs.
 *
 * ## Ordering rules learned from this harness
 *
 * 1. **Reload, then mock — never the reverse.** The harness installs mocks on
 *    `window.__wdio_mocks__`, which a page load discards. Reloading after
 *    mocking falls through to the real provider, and the spec then asserts
 *    against live account data while believing it stubbed something.
 *
 * 2. **Never mutate the persisted store to set up a spec.** Workers run
 *    against one app instance, so writing `onboarding.json` from one spec file
 *    races every other file that reads it. The gate is mocked instead.
 *
 * 3. **A mock must answer every request the app makes.** An unhandled request
 *    falls to the default arm, and a decode failure there silently changes
 *    which screen renders.
 *
 * ## Interception (verified against the plugin source and page probes)
 *
 * The plugin's `Object.defineProperty` interception of
 * `window.__TAURI__.core.invoke` does not take on WKWebView, so
 * `installDispatch` also assigns the property directly — `@tauri-apps/api`
 * v2 resolves it at call time — routing through the plugin's own
 * `__wdio_mocks__` registry. The mock implementation must be closure-free:
 * fixture data is handed to the page as JSON (`__ismFixtures__`), because a
 * Node-side closure does not survive serialization and the mock then answers
 * `undefined` fixtures instead of the configured ones.
 *
 * Real `codex app-server` reads from the e2e binary are also what kills the
 * webview mid-suite (a second read racing the first). With interception in
 * place before the first refresh, every later read is mocked and the app
 * never touches the real provider again.
 */

/**
 * The invoke patch. Unused since the mock moved fully page-side — the app's
 * own `invoke` in `~/lib/ipc` consults `__wdio_mocks__` at call time, so no
 * property patching is needed. Kept out of the file rather than deleted as a
 * reminder that property patching was verified unnecessary.
 */

/** Stores fixture data in the page, readable by the closure-free mock. */
async function storeFixtures(fixtures: DispatchFixtures): Promise<boolean> {
  return browser.execute((data) => {
    (
      window as unknown as { __ismFixtures__?: DispatchFixtures }
    ).__ismFixtures__ = data;
    return true;
  }, fixtures);
}

// ---------------------------------------------------------------------------
// The persisted onboarding store
//
// The old rule — never write the store from a spec — existed because two
// workers drove one renderer and one disk. The grouped `specs` config runs
// everything in ONE ordered worker, so with a save/restore around each use
// there is nothing left to race: the store is seeded before the app launches,
// every boot therefore starts from a known gate, and the original bytes come
// back at the end of the run.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The persisted route
//
// The app remembers the last destination across launches, so a developer
// machine left on Settings reopens on Settings and every assumption of
// "starts on Home" quietly fails. Seeded the same way as the onboarding gate,
// and restored at the end of the run.
// ---------------------------------------------------------------------------

function settingsStorePath(): string {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "com.soumitrasaha.agentgauge",
    "settings.json",
  );
}

let savedSettingsStore: string | null | undefined;

/** Seeds the persisted route to Home before the app launches. */
export function seedRoute(route: "home" = "home"): void {
  const file = settingsStorePath();
  if (savedSettingsStore === undefined) {
    savedSettingsStore = fs.existsSync(file)
      ? fs.readFileSync(file, "utf8")
      : null;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ lastRoute: route }));
}

/**
 * Opens the app and waits for a surface, retrying the whole cycle.
 *
 * The window is created by the platform after the session attaches, so the
 * first navigation of a run can land before the window exists and every
 * element lookup then fails for its full timeout (verified with a screenshot:
 * the app renders perfectly seconds later). Two attempts is enough.
 */
export async function openApp(): Promise<void> {
  // Wait for the native window to exist before navigating. The WebDriver
  // session attaches to the app process, which can be up before its window is
  // created; navigating in that gap finds no window at all, and every element
  // lookup then fails for its full timeout (verified: a screenshot taken
  // moments later shows the app rendered perfectly). Retried, because the
  // window is also recreated if it was closed.
  await waitForWindow();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await browser.tauri.switchWindow("main");
    // Exactly `tauri://localhost`, always. This DOES remount the document
    // (verified: a boot that seeds the store first always reads the fresh
    // value), which is what the seeding depends on. Two alternatives were
    // tried and both are wrong: `?boot=…` stops the custom protocol
    // resolving the index, and `index.html` resolves only on a warm app — a
    // cold start renders a blank page. `browser.refresh()` closes the window.
    await browser.url("tauri://localhost");
    // Polls `isDisplayed` explicitly instead of `waitForDisplayed`. This
    // driver's `waitForDisplayed` reports failure for a rendered element on a
    // comma selector — verified directly: the same element answers `true` to
    // `isDisplayed` while `waitForDisplayed` times out, and the page is fully
    // painted (33k of markup). Trusting the timeout here made every boot
    // report "the app never rendered a surface" while the app was sitting
    // there, rendering correctly.
    if (
      await pollForDisplayed(
        ['[data-testid="app-shell"]', '[data-testid="onboarding"]'],
        15_000,
      )
    ) {
      return;
    }
    // The window may have closed between attempts; give the app a moment.
    await browser.pause(1500);
    await waitForWindow();
  }
  throw new Error("the app never rendered a surface");
}

/**
 * Polls each selector in turn until one of them is displayed.
 *
 * ## Why not a single comma selector
 *
 * `$(a, b).isDisplayed()` answers for the *first* match only. Both surfaces
 * stay mounted while the other is showing, so with
 * `[data-testid="app-shell"], [data-testid="onboarding"]` the hidden
 * `app-shell` comes first in document order and the result is `false` even
 * while onboarding is fully visible. Verified directly: on a live onboarding
 * flow the single selector and wdio's own `toBeDisplayed` matcher both report
 * displayed, while the comma selector reports not displayed — the same element,
 * the same instant.
 *
 * That made `openApp` report "the app never rendered a surface" while the app
 * sat there rendering perfectly, and it is the reason the onboarding specs
 * failed: their `beforeEach` never got past the boot.
 *
 * Each selector is therefore polled on its own, so "any of these" really does
 * mean any.
 */
export async function pollForDisplayed(
  selectors: string | readonly string[],
  timeoutMs: number,
): Promise<boolean> {
  const list = typeof selectors === "string" ? [selectors] : selectors;
  for (let waited = 0; waited <= timeoutMs; waited += 250) {
    for (const selector of list) {
      const elements = await $$(selector);
      for (const element of elements) {
        if (await element.isDisplayed().catch(() => false)) return true;
      }
    }
    await browser.pause(250);
  }
  return false;
}

/**
 * Clicks the first *displayed* element matching a selector.
 *
 * `$(selector).click()` answers for the first match in document order, and both
 * surfaces stay mounted while the other is showing — so the button a spec means
 * to press is often not the one `$` returns, and the click fails with "element
 * wasn't found" on a screen that plainly has the button. `firstDisplayed` walks
 * the matches instead of taking the first.
 */
export async function clickDisplayed(selector: string): Promise<void> {
  const target = await firstDisplayed(selector);
  if (!target) {
    throw new Error(`nothing displayed for ${selector}`);
  }
  await target.click();
}

/**
 * Asserts that a selector is displayed, with a wait.
 *
 * The same first-match-only trap as `pollForDisplayed` applies to a bare
 * `expect(el).toBeDisplayed()` when several elements share a `data-testid`, so
 * every assertion about visibility goes through here. `toBeDisplayed()` itself
 * is reliable for a selector that matches exactly one *displayed* element —
 * the failure was never the matcher, it was the comma selector feeding it.
 *
 * Waits rather than asserting immediately, because most of these follow a click
 * that only *starts* a re-read; asserting straight away races the very render
 * being waited on.
 */
export async function expectDisplayed(
  selector: string,
  timeoutMs = 10_000,
): Promise<void> {
  if (await pollForDisplayed(selector, timeoutMs)) return;
  throw new Error(`expected ${selector} to be displayed within ${timeoutMs}ms`);
}

/** Resolves once the native window is listed, retrying while it is absent. */
async function waitForWindow(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const windows = await browser
      .getWindowHandles()
      .catch(() => [] as string[]);
    if (windows.length > 0) return;
    await browser.pause(500);
  }
  throw new Error("the app never created its window");
}

function onboardingStorePath(): string {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "com.soumitrasaha.agentgauge",
    "onboarding.json",
  );
}

let savedOnboardingStore: string | null | undefined;

/**
 * Seeds the persisted onboarding gate before the app launches.
 *
 * `visible: true` = a fresh user (flow shows); `false` = dismissed. Must be
 * called BEFORE the boot's `url()`.
 */
export function seedOnboardingStore(visible: boolean): void {
  // `visible` means what it says: `true` seeds a fresh user whose flow shows.
  // An inverted call site is the single easiest mistake to make here, and it
  // fails silently — the app reads a dismissed store and the gate never opens.
  const file = onboardingStorePath();
  if (savedOnboardingStore === undefined) {
    savedOnboardingStore = fs.existsSync(file)
      ? fs.readFileSync(file, "utf8")
      : null;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      visible
        ? { step: "welcome", dismissed: false }
        : { step: "done", dismissed: true },
    ),
  );
}

/**
 * Puts the original persisted stores back. Call once, at the end of the run.
 *
 * Both stores are restored together: a run that seeds only onboarding leaves
 * the route as the last spec's navigation set it, which then changes what the
 * next run's app opens on.
 */
export function restoreOnboardingStore(): void {
  for (const [file, saved] of [
    [onboardingStorePath(), savedOnboardingStore],
    [settingsStorePath(), savedSettingsStore],
  ] as const) {
    if (saved === undefined) continue;
    if (saved === null) {
      fs.rmSync(file, { force: true });
    } else {
      fs.writeFileSync(file, saved);
    }
  }
  savedOnboardingStore = undefined;
  savedSettingsStore = undefined;
}

/** A live-looking Codex reading: 12% used, an hour to reset. */
export function liveSnapshot(overrides: Record<string, unknown> = {}) {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const fiveHour = {
    label: "5h",
    usedPercent: 12,
    durationMins: 300,
    resetsAt,
    remainingPercent: 88,
  };
  return {
    provider: "codex",
    freshness: "live",
    fetchedAt: Date.now(),
    source: "codex app-server",
    reason: null,
    plan: "team",
    permission: "allowed",
    windows: [
      fiveHour,
      {
        label: "weekly",
        usedPercent: 54,
        durationMins: 10080,
        resetsAt: Math.floor(Date.now() / 1000) + 86400,
        remainingPercent: 46,
      },
    ],
    fiveHour,
    weekly: {
      label: "weekly",
      usedPercent: 54,
      durationMins: 10080,
      resetsAt: Math.floor(Date.now() / 1000) + 86400,
      remainingPercent: 46,
    },
    ...overrides,
  };
}

/** A signed-out reading. Must render as an explicit state, never as zero. */
export function unavailableSnapshot() {
  return {
    provider: "codex",
    freshness: "unavailable",
    fetchedAt: null,
    source: "codex app-server",
    reason: "Sign in with `codex login` to see your usage.",
    plan: null,
    permission: "unknown",
    windows: [],
    fiveHour: null,
    weekly: null,
  };
}

/** A connected coding plan, as OpenCode would report it. */
export function subscription(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "zai-coding-plan",
    name: "Z.AI Coding Plan",
    label: "Z.AI",
    integration: "zai",
    credential: "stored",
    apiBase: "https://api.z.ai/api/coding/paas/v4",
    ...overrides,
  };
}

/** A live-looking Z.AI reading: 16% used of the 5-hour window. */
export function zaiSnapshot(overrides: Record<string, unknown> = {}) {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const fiveHour = {
    label: "5h",
    usedPercent: 16,
    durationMins: 300,
    resetsAt,
    remainingPercent: 84,
  };
  return {
    provider: "zai",
    freshness: "live",
    fetchedAt: Date.now(),
    source: "z.ai coding plan",
    reason: null,
    plan: "pro",
    permission: "unknown",
    windows: [
      fiveHour,
      {
        label: "weekly",
        usedPercent: 35,
        durationMins: 10080,
        resetsAt: Math.floor(Date.now() / 1000) + 86400,
        remainingPercent: 65,
      },
    ],
    fiveHour,
    weekly: {
      label: "weekly",
      usedPercent: 35,
      durationMins: 10080,
      resetsAt: Math.floor(Date.now() / 1000) + 86400,
      remainingPercent: 65,
    },
    ...overrides,
  };
}

export interface DispatchFixtures {
  readonly visible: boolean;
  readonly usage: Record<string, unknown>;
  readonly installed: boolean;
  readonly version: string | null;
  /**
   * Coding subscriptions OpenCode reports, as the `openCodeSubscriptions`
   * reply would carry them. Absent means "none connected" — Codex only.
   */
  readonly subscriptions?: readonly Record<string, unknown>[];
  /**
   * Per-provider usage replies for `readUsageFor`, keyed by provider kind.
   * `codex` is not needed here: the single `usage` fixture serves it.
   */
  readonly usageByProvider?: Record<string, Record<string, unknown>>;
  /**
   * Whether this build contains the widget extension.
   *
   * Replaces the old `widgetInstalled`, which meant "a floating window was open".
   * Nothing opens a window now: the extension is either embedded in the bundle
   * or it is not.
   */
  readonly widgetEmbedded: boolean;
  readonly widgetSupported: boolean;
  readonly automationRunning: boolean;
  readonly analyticsEnabled?: boolean;
}

/**
 * Installs a `dispatch` mock and settles the app on it.
 *
 * The mock is written **directly into the page's `window.__wdio_mocks__`** —
 * which is exactly what `invoke` in `~/lib/ipc` consults at call time. The
 * plugin's `browser.tauri.mock` was found to register in a different WKWebView
 * script world than the one the app reads (verified with a self-check that saw
 * the registry in one world and not the other), so nothing of it is used.
 *
 * Fixture data crosses as JSON (`__ismFixtures__`), not as a closure: a Node
 * closure does not survive serialization into the page.
 */
/** The dispatch mock, registered by `installDispatch`. */
export async function installDispatch(fixtures: DispatchFixtures) {
  // The install + self-check occasionally races a page swap (the self-check
  // then sees a fresh world with neither fixtures nor registry). One retry on
  // a reloaded page converts that flake into a pass.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await installDispatchOnce(fixtures);
      return;
    } catch (error) {
      lastError = error;
      await browser.url("tauri://localhost");
      await waitForAnySurface();
      await browser.pause(1000);
    }
  }
  throw lastError;
}

async function installDispatchOnce(fixtures: DispatchFixtures) {
  await storeFixtures(fixtures);

  // The dispatcher, in the app's own world. Every request type the app can
  // issue is answered, including the onboarding and ui-state writes: an
  // unhandled request falls to the default arm, and a decode failure there
  // silently changes which screen renders. Calls are recorded so specs can
  // assert on writes without touching the on-disk files.
  await browser.execute(() => {
    const w = window as unknown as {
      __ismFixtures__?: Record<string, unknown>;
      __ismMockCalls__?: Array<Record<string, unknown>>;
      __ismOnboarding__?: { step: string; dismissed: boolean };
      __ismAnalyticsEnabled__?: boolean;
      __wdio_mocks__: Record<
        string,
        (args: unknown) => Promise<Record<string, unknown>>
      >;
    };
    // The registry may not exist in this world yet: the plugin creates it in
    // its own script world, and the app's `invoke` reads this one. Create it
    // here, exactly the shape `invoke` expects.
    w.__wdio_mocks__ = w.__wdio_mocks__ ?? {};
    w.__ismMockCalls__ = [];
    const f = (): Record<string, unknown> => w.__ismFixtures__ ?? {};
    const record = (request: Record<string, unknown> | undefined) => {
      w.__ismMockCalls__?.push(request ?? {});
    };
    // The persisted onboarding state, mirroring the Rust store: `visible` is
    // `!dismissed && step != "done"`, derived on every read from the last
    // write. Without the write-through state, a step navigation answered with
    // the initial step again and the flow could never advance under the mock.
    const ORDER = [
      "welcome",
      "statusCheck",
      "windowRollover",
      "widget",
      "automation",
    ];
    w.__ismOnboarding__ = {
      step: f().visible ? "welcome" : "done",
      dismissed: !f().visible,
    };
    w.__ismAnalyticsEnabled__ = f().analyticsEnabled === true;
    const dispatcher = async (args?: {
      request?: Record<string, unknown>;
    }): Promise<Record<string, unknown>> => {
      const request = args?.request;
      record(request);
      const data = f();
      switch (request?.type) {
        case "onboardingProgress":
        case "setOnboardingStep": {
          if (request.type === "setOnboardingStep" && w.__ismOnboarding__) {
            w.__ismOnboarding__ = {
              step: (request.step as string) ?? "welcome",
              dismissed: request.dismissed === true || request.step === "done",
            };
          }
          const state = w.__ismOnboarding__ ?? {
            step: "done",
            dismissed: true,
          };
          const done = state.dismissed || state.step === "done";
          const index = done
            ? ORDER.length
            : Math.max(0, ORDER.indexOf(state.step));
          return {
            type: "onboarding",
            progress: {
              step: done ? "done" : state.step,
              dismissed: state.dismissed,
              visible: !done,
              index,
              total: ORDER.length + 1,
            },
          };
        }
        case "readUsage":
          return { type: "usage", snapshots: [data.usage] };
        case "openCodeSubscriptions":
          return {
            type: "openCodeSubscriptions",
            subscriptions: data.subscriptions ?? [],
          };
        case "readAccountUsage":
          return {
            type: "accountUsage",
            usage: {
              fetchedAt: 1791561935000,
              summary: {
                lifetimeTokens: 1234567,
                peakDailyTokens: 45678,
                longestRunningTurnSec: 540,
                currentStreakDays: 8,
                longestStreakDays: 14,
              },
              dailyUsageBuckets: [
                { startDate: "2026-10-07", tokens: 2300 },
                { startDate: "2026-10-08", tokens: 0 },
                { startDate: "2026-10-09", tokens: 12345 },
              ],
            },
          };
        case "providerStatus":
          return {
            type: "providerStatuses",
            providers: [
              {
                kind: "codex",
                executable: "codex",
                installed: data.installed,
                version: data.version ?? null,
                reason: data.installed
                  ? null
                  : "`codex` is not available on this system.",
              },
            ],
          };
        case "cliDetection":
          return {
            type: "cliDetections",
            tools: [
              {
                tool: "codex",
                displayName: "Codex CLI",
                executable: "codex",
                installed: data.installed,
                version: data.version ?? null,
                reason: data.installed
                  ? null
                  : "`codex` is not available on this system.",
              },
              {
                tool: "openCode",
                displayName: "OpenCode CLI",
                executable: "opencode",
                installed: true,
                version: "opencode 1.0.0",
                reason: null,
              },
            ],
          };
        case "automationState":
        case "startAutomation":
        case "stopAutomation":
        case "acknowledgeRollover":
          return {
            type: "automation",
            state: {
              running: data.automationRunning,
              usage: null,
              lastPolledAt: Date.now(),
              rolledOver: false,
              observedResetsAt: Math.floor(Date.now() / 1000) + 3600,
              rolledOverAt: null,
              nextPollAt: null,
            },
          };
        case "systemWidgetStatus":
          return {
            type: "systemWidget",
            status: {
              supported: data.widgetSupported,
              system: data.widgetSupported ? "widgetKit" : "none",
              osVersion: data.widgetSupported ? "27.0" : null,
              minimumVersion: "14.0",
              extensionBundled: true,
              extensionPresent: data.widgetEmbedded,
              snapshotWritten: data.widgetEmbedded,
              menuBarAvailable: data.widgetSupported,
              reason: data.widgetSupported
                ? null
                : "The system widget is implemented for macOS only.",
              setup: !data.widgetSupported
                ? []
                : data.widgetEmbedded
                  ? [
                      {
                        title: "Open the widget gallery",
                        detail:
                          "Right-click the desktop and choose Edit Widgets.",
                      },
                      {
                        title: "Find AgentGauge",
                        detail: "Search for \u201cAgentGauge\u201d.",
                      },
                    ]
                  : [
                      {
                        title: "Run the packaged app, not the dev server",
                        detail:
                          "This build does not contain the widget extension.",
                      },
                    ],
            },
          };
        case "sendPing":
          // Mirrors the Rust boundary: the length limit is enforced before
          // anything is sent, and an over-long prompt is a typed failure. The
          // mock never sends a ping — a real one consumes quota.
          if (((request.prompt as string) ?? "").length > 280) {
            return {
              type: "failure",
              error: {
                kind: "invalidRequest",
                message: "The ping message is too long.",
              },
            };
          }
          return { type: "protocol", version: 1 };
        case "readPlan":
        case "readUsageFor": {
          const perProvider = data.usageByProvider?.[
            request.provider as string
          ] as Record<string, unknown> | undefined;
          if (request.type === "readUsageFor" && perProvider) {
            return { type: "usage", snapshots: [perProvider] };
          }
          // Same boundary as Rust: only a registered provider may be read.
          if (request.provider !== "codex") {
            return {
              type: "failure",
              error: {
                kind: "unsupportedProvider",
                message: "That provider is not registered.",
              },
            };
          }
          return {
            type: "readPlan" === request.type ? "plan" : "usage",
            ...(request.type === "readPlan"
              ? { plan: (f().usage as { plan?: string })?.plan ?? null }
              : { snapshots: [f().usage] }),
          };
        }
        case "uiState":
        case "setUiState":
          // The route write is a deliberate no-op: a spec must never write the
          // persisted settings file (the same on-disk state race rule as
          // onboarding), so a navigation inside a spec persists nothing.
          return {
            type: "uiState",
            state: {
              lastRoute:
                request?.type === "setUiState"
                  ? ((request.lastRoute as string | null) ?? null)
                  : null,
              analyticsEnabled: w.__ismAnalyticsEnabled__ === true,
            },
          };
        case "setAnalyticsConsent":
          w.__ismAnalyticsEnabled__ = request.enabled === true;
          return {
            type: "uiState",
            state: {
              lastRoute: null,
              analyticsEnabled: w.__ismAnalyticsEnabled__,
            },
          };
        default:
          return { type: "protocol", version: 1 };
      }
    };
    w.__wdio_mocks__["dispatch"] = dispatcher;
    return Object.keys(w.__wdio_mocks__);
  });

  // Self-verify, because a mock that silently misses costs minutes per run:
  // call the registry exactly the way the app does (see `invoke` in
  // `~/lib/ipc`: it reads `__wdio_mocks__` at call time) and require a real
  // usage answer, not the default arm.
  const proof = (await browser.execute(async () => {
    const w = window as unknown as {
      __wdio_mocks__?: Record<
        string,
        (args: unknown) => Promise<Record<string, unknown>>
      >;
      __ismFixtures__?: unknown;
    };
    try {
      const response = await w.__wdio_mocks__?.dispatch?.({
        request: { type: "readUsage" },
      });
      const usage = response as { snapshots?: unknown[] } | undefined;
      return {
        type: response?.type ?? null,
        snapshots: Array.isArray(usage?.snapshots)
          ? usage.snapshots.length
          : -1,
        fixtures: w.__ismFixtures__ != null,
        registry: Object.keys(w.__wdio_mocks__ ?? {}),
      };
    } catch (error) {
      return { threw: String(error) };
    }
  })) as {
    type?: string | null;
    snapshots?: number;
    fixtures?: boolean;
    registry?: string[];
    threw?: string;
  };
  if (
    proof.type !== "usage" ||
    (proof.snapshots ?? -1) < 1 ||
    !proof.fixtures
  ) {
    throw new Error(`interception self-check failed: ${JSON.stringify(proof)}`);
  }
}

/**
 * Reloads, mocks, then nudges the UI so the read re-runs.
 *
 * The nudge is a real gesture, so the atoms are refreshed through the same path
 * a user's click would take rather than by poking the registry.
 */
type UiNudge =
  | "test-onboarding-replay"
  | "refresh-provider"
  | "refresh-usage"
  | "refresh-automation"
  | "refresh-widget";

export async function settle(nudge: UiNudge): Promise<void> {
  const target = await firstDisplayed(`[data-testid="${nudge}"]`);
  if (target) {
    // DOM-side click. The driver's native click path was implicated in the
    // embedded driver becoming unreachable mid-suite; a page-level click
    // exercises the same handler without it.
    await browser.execute(
      (el) => (el as HTMLElement).click(),
      target as unknown as HTMLElement,
    );
  }
  await browser.pause(500);
}

/**
 * The first *displayed* element matching a selector, or `null`.
 *
 * Both surfaces stay mounted while the other is showing, so several controls
 * share a `data-testid` — `refresh-widget` belongs to both the dashboard panel
 * and the onboarding step. `$(selector)` returns the first match in document
 * order, which is the hidden one, so clicking it refreshes nothing and the spec
 * then asserts against the value the atom read before the mock existed.
 */
async function firstDisplayed(
  selector: string,
): Promise<WebdriverIO.Element | null> {
  for (const element of await $$(selector)) {
    if (await element.isDisplayed()) return element;
  }
  return null;
}

/**
 * Navigates to a destination through the real navigation.
 *
 * A click, not a registry write: the shell treats a user gesture and a spec
 * gesture identically, including the persistence write (which the mock absorbs,
 * so a spec never touches the on-disk settings file).
 */
export async function gotoView(
  view: "home" | "automation" | "stats" | "settings",
): Promise<void> {
  const button = await firstDisplayed(`[data-testid="nav-${view}"]`);
  if (!button) {
    throw new Error(`nav-${view} is not displayed — is the shell visible?`);
  }
  // DOM-side click; see `settle` for why the native path is avoided.
  await browser.execute(
    (el) => (el as HTMLElement).click(),
    button as unknown as HTMLElement,
  );
  await browser.pause(300);
}

/**
 * The dispatch calls the installed mock has received, newest last.
 *
 * The call log lives in the page next to the mock, so a spec can assert on
 * writes (does a navigation persist?) without touching the on-disk files.
 */
export async function dispatchCalls(): Promise<Array<Record<string, unknown>>> {
  return browser.execute(
    () =>
      (
        window as unknown as {
          __ismMockCalls__?: Array<Record<string, unknown>>;
        }
      ).__ismMockCalls__ ?? [],
  );
}

/**
 * Installs fixtures, then drives the app onto them.
 *
 * The app is loaded *before* the mock exists, so its first read has already
 * happened by then. Rather than reload (which would discard the mock), real
 * onboarding navigation and each panel's own refresh action nudge the atoms.
 *
 * The wait is explicit rather than a fixed pause: the refresh click only
 * *starts* a re-read, and asserting immediately after would race the very
 * atoms being refreshed. Each settle waits for the surface to reach the state
 * the fixtures asked for.
 */
export async function boot(fixtures: DispatchFixtures): Promise<void> {
  // The gate and the route are seeded on disk BEFORE the app launches, so the
  // mount-time read answers what the fixtures need — no post-hoc fixing.
  //
  // Straight pass-through, deliberately NOT `!fixtures.visible`: the store's
  // `visible` already means "the flow should show". Inverting it here seeded
  // every onboarding-visible boot with a *dismissed* store, so the gate never
  // opened and all 12 onboarding specs failed on a page that was otherwise
  // correct. Verified by printing the file after `openApp`: it read
  // `{"step":"done","dismissed":true}` for a spec that had asked for the flow.
  seedOnboardingStore(fixtures.visible);
  seedRoute("home");

  await openApp();

  // Wait out the mount-time read before installing the mock. A refresh that
  // lands while the first read is still in flight is coalesced into it, so
  // the atom completes with the REAL response and the fixture never lands —
  // verified as exactly the specs that assert fixture-only values failing.
  // Spawning `codex app-server` takes seconds, hence the generous bound; a
  // read that already finished (or never started) passes straight through.
  for (let waited = 0; waited < 20_000; waited += 500) {
    const loading = await $('[data-testid="usage-loading"]');
    if (!(await loading.isExisting())) break;
    await browser.pause(500);
  }

  await installDispatch(fixtures);

  if (fixtures.visible) {
    if (await firstDisplayed('[data-testid="onboarding"]')) {
      await clickDisplayed('[data-testid="onboarding-skip"]');
    }
    await expectDisplayed('[data-testid="app-shell"]');
    await clickDisplayed('[data-testid="nav-test"]');
    await settle("test-onboarding-replay");
  }

  // Every atom the surface shows is nudged, not just the first one found.
  // Each panel owns its own refresh control and reads its own atom; since the
  // navigation, several of those controls live on other destinations, so the
  // pass VISITS each one — a hidden view's refresh control cannot be clicked.
  //
  // The loop runs TWICE. `url()` to the same URL does not always remount the
  // document, so the first pass can complete against the previous page state.
  // The second pass re-issues every read through whatever mock is registered
  // now.
  // The test-only replay control above makes visible-onboarding boots
  // deterministic even when a same-URL navigation preserves session atoms.
  const nudges = [
    ...(fixtures.visible
      ? []
      : [
          { view: "home", control: "refresh-provider" },
          { view: "home", control: "refresh-usage" },
          { view: "automation", control: "refresh-automation" },
          { view: "settings", control: "refresh-widget" },
        ]),
  ] as ReadonlyArray<{
    view: "home" | "automation" | "settings" | null;
    control: UiNudge;
  }>;
  for (let pass = 0; pass < 2; pass += 1) {
    for (const { view, control } of nudges) {
      // The shell is hidden while onboarding shows, so its destinations are
      // unreachable — that is correct, and the nudges for them are skipped.
      if (view) {
        try {
          await gotoView(view);
        } catch {
          continue;
        }
      }
      await settle(control);
    }
  }

  // The nudge trail above ends on the last visited destination, but every
  // spec asserts against Home's panels; leave the app where the assertions
  // are, so "displayed" means what the spec says and not wherever the last
  // nudge happened to land.
  try {
    await gotoView("home");
  } catch {
    // A navigation failure here is the suite's problem to surface, not a
    // reason to hide the surface the fixtures describe.
  }

  await waitForSurface(fixtures);
}
/** Waits for either surface to have rendered. */
async function waitForAnySurface(): Promise<void> {
  await pollForDisplayed(
    ['[data-testid="onboarding"]', '[data-testid="app-shell"]'],
    10_000,
  );
}

/**
 * Waits for the app to settle onto the fixtures.
 *
 * Asserts the gate the fixtures asked for, then that the usage panel has left
 * its loading state. Without this the first spec in a run reads whatever the
 * previous run left behind.
 */
async function waitForSurface(fixtures: DispatchFixtures): Promise<void> {
  const gate = fixtures.visible
    ? '[data-testid="onboarding"]'
    : '[data-testid="app-shell"]';
  // Throws on failure. This previously discarded the poll's result, so a boot
  // that never reached the requested surface passed silently and every spec
  // behind it failed on a confusing missing element instead.
  if (!(await pollForDisplayed(gate, 10_000))) {
    const seen = await browser
      .execute(() => {
        const shell = document.querySelector('[data-testid="app-shell"]');
        return {
          onboarding: !!document.querySelector('[data-testid="onboarding"]'),
          shellClass: shell?.className ?? null,
          heading:
            document.querySelector("h1")?.textContent?.slice(0, 40) ?? null,
        };
      })
      .catch(() => null);
    throw new Error(
      `boot never reached "${gate}" — page state: ${JSON.stringify(seen)}`,
    );
  }

  // The usage panel must have resolved: either real rows, or the explicit
  // unavailable state. Either proves the read came back rather than lingering
  // on a skeleton.
  //
  // Only asserted when the dashboard is the visible surface. The onboarding
  // flow's *first* step deliberately shows no usage panel at all, so waiting
  // for one there would block forever on a correct render.
  if (!fixtures.visible) {
    await pollForDisplayed(
      ['[data-testid="window-bar"]', '[data-testid="window-unavailable"]'],
      10_000,
    );
  }
}

/** The default: onboarding visible, Codex installed and reporting live data. */
export async function onboardingVisible(): Promise<void> {
  await boot({
    visible: true,
    usage: liveSnapshot({ plan: "pro" }),
    installed: true,
    version: "codex-cli 0.159.0",
    widgetEmbedded: true,
    widgetSupported: true,
    automationRunning: true,
  });
}

/** Onboarding dismissed, dashboard showing live data. */
export async function dashboardLive(): Promise<void> {
  await boot({
    visible: false,
    usage: liveSnapshot(),
    installed: true,
    version: "codex-cli 0.159.0",
    widgetEmbedded: true,
    widgetSupported: true,
    automationRunning: true,
  });
}

/**
 * Onboarding dismissed, with a Z.AI plan and an unreadable Alibaba plan
 * connected through OpenCode beside Codex.
 */
export async function dashboardWithPlans(): Promise<void> {
  await boot({
    visible: false,
    usage: liveSnapshot(),
    subscriptions: [
      subscription(),
      subscription({
        providerId: "alibaba-coding-plan",
        name: "Alibaba Coding Plan",
        label: "Alibaba Coding Plan",
        integration: null,
        apiBase: null,
      }),
    ],
    usageByProvider: { zai: zaiSnapshot() },
    installed: true,
    version: "codex-cli 0.159.0",
    widgetEmbedded: true,
    widgetSupported: true,
    automationRunning: true,
  });
}

/** Onboarding dismissed, dashboard showing an explicit unavailable state. */
export async function dashboardUnavailable(): Promise<void> {
  await boot({
    visible: false,
    usage: unavailableSnapshot(),
    installed: false,
    version: null,
    widgetEmbedded: true,
    widgetSupported: true,
    automationRunning: false,
  });
}

/** Onboarding visible, but nothing can be read at all. */
export async function onboardingWithNoData(): Promise<void> {
  await boot({
    visible: true,
    usage: unavailableSnapshot(),
    installed: false,
    version: null,
    widgetEmbedded: true,
    widgetSupported: true,
    automationRunning: false,
  });
}

/** The element every dashboard assertion hangs off. */
export function appShell() {
  return $('[data-testid="app-shell"]');
}
