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
 */

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

export interface DispatchFixtures {
  readonly visible: boolean;
  readonly usage: Record<string, unknown>;
  readonly installed: boolean;
  readonly version: string | null;
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
}

/**
 * Installs a `dispatch` mock and settles the app on it.
 *
 * Every request type the app can issue is answered, including the onboarding
 * write: skipping the flow must not produce a decode failure, which would leave
 * the dashboard hidden for the rest of the file.
 */
export async function installDispatch(fixtures: DispatchFixtures) {
  const dispatch = await browser.tauri.mock("dispatch");

  await dispatch.mockImplementation(
    async ({ payload }: { payload?: { request?: Record<string, never> } }) => {
      const request = payload?.request as
        | { type?: string; step?: string }
        | undefined;
      switch (request?.type) {
        case "onboardingProgress":
        case "setOnboardingStep":
          return {
            type: "onboarding",
            progress: {
              step: request?.step ?? "welcome",
              dismissed: !fixtures.visible,
              visible: fixtures.visible,
              index: fixtures.visible ? 0 : 5,
              total: 6,
            },
          };
        case "readUsage":
          return { type: "usage", snapshots: [fixtures.usage] };
        case "providerStatus":
          return {
            type: "providerStatuses",
            providers: [
              {
                kind: "codex",
                executable: "codex",
                installed: fixtures.installed,
                version: fixtures.version,
                reason: fixtures.installed
                  ? null
                  : "`codex` is not available on this system.",
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
              running: fixtures.automationRunning,
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
              supported: fixtures.widgetSupported,
              system: fixtures.widgetSupported ? "widgetKit" : "none",
              osVersion: fixtures.widgetSupported ? "27.0" : null,
              minimumVersion: "14.0",
              extensionBundled: true,
              extensionPresent: fixtures.widgetEmbedded,
              snapshotWritten: fixtures.widgetEmbedded,
              menuBarAvailable: fixtures.widgetSupported,
              reason: fixtures.widgetSupported
                ? null
                : "The system widget is implemented for macOS only.",
              setup: !fixtures.widgetSupported
                ? []
                : fixtures.widgetEmbedded
                  ? [
                      {
                        title: "Open the widget gallery",
                        detail:
                          "Right-click the desktop and choose Edit Widgets.",
                      },
                      {
                        title: "Find AI Sub Stats",
                        detail: "Search for \u201cAI Sub Stats\u201d.",
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
        default:
          return { type: "protocol", version: 1 };
      }
    },
  );

  await dispatch.update();
}

/**
 * Reloads, mocks, then nudges the UI so the read re-runs.
 *
 * The nudge is a real gesture, so the atoms are refreshed through the same path
 * a user's click would take rather than by poking the registry.
 */
export async function settle(
  nudge: "onboarding-refresh" | "refresh-usage" | "refresh-widget",
): Promise<void> {
  const target = await firstDisplayed(`[data-testid="${nudge}"]`);
  if (target) {
    await target.click();
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
 * Installs fixtures, then drives the app onto them.
 *
 * The app is loaded *before* the mock exists, so its first read has already
 * happened by then. Rather than reload (which would discard the mock), the
 * refresh control is used: the onboarding flow's "Re-read" covers every atom
 * the app shows, so one click settles the whole surface.
 *
 * The wait is explicit rather than a fixed pause: the refresh click only
 * *starts* a re-read, and asserting immediately after would race the very
 * atoms being refreshed. Each settle waits for the surface to reach the state
 * the fixtures asked for.
 */
export async function boot(fixtures: DispatchFixtures): Promise<void> {
  // Navigate FIRST, install the mock SECOND.
  //
  // `window.__wdio_mocks__` is cleared by any navigation: a reload or `url()`
  // after `mock()` empties the registry, and the app then silently falls
  // through to the real provider. This was verified directly — the registry
  // reads `[]` immediately after `browser.url()`.
  await browser.tauri.switchWindow("main");
  await browser.url("tauri://localhost");
  await waitForAnySurface();

  await installDispatch(fixtures);

  // Every atom the surface shows is nudged, not just the first one found. Each
  // panel owns its own refresh control and reads its own atom, so settling only
  // usage leaves the widget panel asserting against the value it read before the
  // mock existed — which on a dev build is "not embedded", not the fixture.
  for (const nudge of [
    "onboarding-refresh",
    "refresh-usage",
    "refresh-widget",
  ] as const) {
    await settle(nudge);
  }

  // If the fixtures want the flow shown but it is not up, the persisted gate
  // disagreed. That happens because the gate is decided by an atom read that
  // only re-runs through the flow's own control — and the flow is not on screen
  // to click. Reset through the renderer instead: a navigation re-runs every
  // atom against the mock that is already installed.
  //
  // Reinstalling is required rather than re-navigating: a navigation clears
  // the registry that produced the wrong gate in the first place.
  if (fixtures.visible) {
    const flow = await $('[data-testid="onboarding"]');
    if (!(await flow.isExisting())) {
      await installDispatch(fixtures);
      await browser.pause(400);
    }
  }

  await waitForSurface(fixtures);
}

/** Waits for either surface to have rendered. */
async function waitForAnySurface(): Promise<void> {
  await $('[data-testid="onboarding"], [data-testid="dashboard"]').waitForDisplayed({
    timeout: 10_000,
  });
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
    : '[data-testid="dashboard"]';
  await $(gate).waitForDisplayed({ timeout: 10_000 });

  // The usage panel must have resolved: either real rows, or the explicit
  // unavailable state. Either proves the read came back rather than lingering
  // on a skeleton.
  //
  // Only asserted when the dashboard is the visible surface. The onboarding
  // flow's *first* step deliberately shows no usage panel at all, so waiting
  // for one there would block forever on a correct render.
  if (!fixtures.visible) {
    await $(
      '[data-testid="window-bar"], [data-testid="window-unavailable"]',
    ).waitForDisplayed({ timeout: 10_000 });
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
export function dashboard() {
  return $('[data-testid="dashboard"]');
}