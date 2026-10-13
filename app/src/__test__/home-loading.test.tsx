import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let automationResolvers: Array<(value: unknown) => void> = [];
let usageRefreshResolvers: Array<(value: unknown) => void> = [];
let HomeView: ComponentType<{ visible: boolean }>;

function releaseAutomationReads(reply: unknown): void {
  for (const resolve of automationResolvers.splice(0)) resolve(reply);
}

function usageResponse(remainingPercent: number) {
  const window = {
    label: "5h",
    usedPercent: 100 - remainingPercent,
    durationMins: 300,
    resetsAt: Math.floor(Date.now() / 1000) + 3_600,
    remainingPercent,
  };
  return {
    type: "usage",
    snapshots: [
      {
        provider: "codex",
        freshness: "live",
        fetchedAt: Date.now(),
        source: "test harness",
        reason: null,
        plan: "team",
        permission: "allowed",
        fiveHour: window,
        weekly: null,
        windows: [window],
      },
    ],
  };
}

function renderHome(): void {
  render(createElement(HomeView, { visible: true }));
}

beforeEach(async () => {
  vi.resetModules();
  HomeView = (await import("~/components/views/home-view")).HomeView;
});

afterEach(() => {
  for (const resolve of usageRefreshResolvers.splice(0)) {
    resolve(usageResponse(65));
  }
  releaseAutomationReads({
    type: "automation",
    monitors: [
      {
        kind: "codex",
        running: false,
        lastPolledAt: null,
        nextPollAt: null,
        observedResetsAt: null,
        rolledOver: false,
        rolledOverAt: null,
      },
    ],
  });
  delete (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__;
  cleanup();
});

it("shows monitor status as loading rather than an unavailable error", async () => {
  automationResolvers = [];
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: ({ request }: { request: { type: string } }) => {
      if (request.type === "automationState") {
        return new Promise((resolve: (value: unknown) => void) => {
          automationResolvers.push(resolve);
        });
      }
      if (request.type === "cliDetection") {
        return { type: "cliDetections", tools: [] };
      }
      if (request.type === "openCodeSubscriptions") {
        return { type: "openCodeSubscriptions", subscriptions: [] };
      }
      if (request.type === "readUsageFor") {
        return { type: "usage", snapshots: [] };
      }
      return {
        type: "failure",
        error: { kind: "protocolMismatch", message: `unexpected request ${request.type}` },
      };
    },
  };
  renderHome();

  const loading = await screen.findByTestId("home-watcher-loading");
  expect(loading.getAttribute("role")).toBe("status");
  expect(loading.querySelector('[data-slot="skeleton"]')).toBeTruthy();
  expect(screen.queryByTestId("home-watcher")).toBeNull();

  releaseAutomationReads({
    type: "automation",
    monitors: [
      {
        kind: "codex",
        running: false,
        lastPolledAt: null,
        nextPollAt: null,
        observedResetsAt: null,
        rolledOver: false,
        rolledOverAt: null,
      },
    ],
  });
  expect((await screen.findByTestId("home-watcher")).textContent).toContain(
    "No rollover monitors are running.",
  );
  expect(screen.queryByTestId("home-watcher-loading")).toBeNull();
});

it("reloads Home usage and shows its skeleton until the fresh reading arrives", async () => {
  let usageReads = 0;
  usageRefreshResolvers = [];
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: ({ request }: { request: { type: string } }) => {
      if (request.type === "automationState") {
        return {
          type: "automation",
          monitors: [
            {
              kind: "codex",
              running: false,
              lastPolledAt: null,
              nextPollAt: null,
              observedResetsAt: null,
              rolledOver: false,
              rolledOverAt: null,
            },
          ],
        };
      }
      if (request.type === "cliDetection") {
        return { type: "cliDetections", tools: [] };
      }
      if (request.type === "openCodeSubscriptions") {
        return { type: "openCodeSubscriptions", subscriptions: [] };
      }
      if (request.type === "readUsageFor") {
        usageReads += 1;
        if (usageReads === 1) return usageResponse(80);
        return new Promise((resolve: (value: unknown) => void) => {
          usageRefreshResolvers.push(resolve);
        });
      }
      return {
        type: "failure",
        error: { kind: "protocolMismatch", message: `unexpected request ${request.type}` },
      };
    },
  };
  renderHome();

  expect((await screen.findByTestId("home-remaining")).textContent).toContain(
    "80",
  );
  expect(usageReads).toBe(1);

  fireEvent.click(screen.getByTestId("refresh-usage"));

  const skeleton = await screen.findByTestId("usage-skeleton");
  expect(skeleton.getAttribute("role")).toBe("status");
  expect(skeleton.getAttribute("aria-label")).toBe("Loading usage");
  expect(usageReads).toBe(2);
  expect(screen.getByTestId("refresh-usage").hasAttribute("disabled")).toBe(
    true,
  );

  usageRefreshResolvers.shift()?.(usageResponse(65));

  expect((await screen.findByTestId("home-remaining")).textContent).toContain(
    "65",
  );
  expect(screen.queryByTestId("usage-skeleton")).toBeNull();
});

it("keeps an unavailable monitor status distinct from its loading skeleton", async () => {
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: ({ request }: { request: { type: string } }) => {
      if (request.type === "automationState") {
        return {
          type: "failure",
          error: { kind: "providerMissing", message: "not available" },
        };
      }
      if (request.type === "cliDetection") {
        return { type: "cliDetections", tools: [] };
      }
      if (request.type === "openCodeSubscriptions") {
        return { type: "openCodeSubscriptions", subscriptions: [] };
      }
      if (request.type === "readUsageFor") {
        return { type: "usage", snapshots: [] };
      }
      return {
        type: "failure",
        error: { kind: "protocolMismatch", message: `unexpected request ${request.type}` },
      };
    },
  };
  renderHome();

  expect((await screen.findByTestId("home-watcher")).textContent).toContain(
    "status is unavailable",
  );
  expect(screen.queryByTestId("home-watcher-loading")).toBeNull();
});
