import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let automationResolvers: Array<(value: unknown) => void> = [];
let HomeView: ComponentType<{ visible: boolean }>;

function releaseAutomationReads(reply: unknown): void {
  for (const resolve of automationResolvers.splice(0)) resolve(reply);
}

function renderHome(): void {
  render(createElement(HomeView, { visible: true }));
}

beforeEach(async () => {
  vi.resetModules();
  HomeView = (await import("~/components/views/home-view")).HomeView;
});

afterEach(() => {
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
