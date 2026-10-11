/**
 * The Automation view must give every connected sub its own monitor, and the
 * running state must read as a *persisted choice*: a sub the user enabled
 * arrives already Running — no Start click, ever — while the others stay
 * Stopped. Toggling writes the choice for exactly that sub.
 *
 * Each test resets the module registry before importing: the automation atom
 * is a session-retained singleton, so a second test would inherit the first
 * test's cached answer instead of its own mock.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Request = { readonly type: string; readonly kind?: string };

let calls: Array<Record<string, unknown>>;

function monitor(
  kind: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind,
    running: false,
    lastPolledAt: null,
    nextPollAt: null,
    observedResetsAt: null,
    rolledOver: false,
    rolledOverAt: null,
    ...overrides,
  };
}

function installDispatch(options: {
  running: Record<string, boolean>;
  rolledOver?: string;
}): void {
  calls = [];
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: ({ request }: { request: Request }) => {
      calls.push(request as Record<string, unknown>);
      switch (request.type) {
        case "openCodeSubscriptions":
          return {
            type: "openCodeSubscriptions",
            subscriptions: [
              {
                providerId: "zai-coding-plan",
                name: "Z.AI Coding Plan",
                label: "Z.AI",
                integration: "zai",
                credential: "stored",
                apiBase: "https://api.z.ai/api/coding/paas/v4",
              },
            ],
          };
        case "automationState":
          return {
            type: "automation",
            monitors: [
              monitor("codex", { running: options.running.codex === true }),
              monitor("zai", {
                running: options.running.zai === true,
                rolledOver: options.rolledOver === "zai",
                rolledOverAt: options.rolledOver === "zai" ? 1_000 : null,
              }),
              monitor("minimax"),
              monitor("kimi"),
            ],
          };
        case "startAutomation":
        case "stopAutomation": {
          options.running[request.kind as string] = request.type === "startAutomation";
          return {
            type: "automation",
            monitors: [
              monitor("codex", { running: options.running.codex === true }),
              monitor("zai", { running: options.running.zai === true }),
              monitor("minimax"),
              monitor("kimi"),
            ],
          };
        }
        case "acknowledgeRollover":
          return {
            type: "automation",
            monitors: [
              monitor("codex"),
              monitor("zai"),
              monitor("minimax"),
              monitor("kimi"),
            ],
          };
        default:
          return {
            type: "failure",
            error: {
              kind: "protocolMismatch",
              message: `unexpected request ${request.type}`,
            },
          };
      }
    },
  };
}

async function renderView(): Promise<void> {
  const { AutomationView } = await import("~/components/views/automation-view");
  const createElementResult = createElement(AutomationView as ComponentType<{
    visible: boolean;
  }>, { visible: true });
  render(createElementResult);
  // The tab set arrives with the subscriptions read; wait for it to settle.
  await screen.findByTestId("automation-panel-zai");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__;
  cleanup();
});

it("gives every connected sub its own monitor card with its own status", async () => {
  installDispatch({ running: { codex: true } });
  await renderView();

  expect(screen.getByTestId("automation-panel-codex")).toBeTruthy();
  expect(screen.getByTestId("automation-panel-zai")).toBeTruthy();

  // The persisted choice: codex was enabled before this render, so its card
  // says Running with no click — the Start button must not reappear for a
  // sub the user already started.
  expect(screen.getByTestId("automation-status-codex").textContent).toBe(
    "Running",
  );
  expect(screen.getByTestId("automation-status-zai").textContent).toBe(
    "Stopped",
  );
});

it("toggling one sub records the choice for exactly that sub", async () => {
  installDispatch({ running: { codex: true } });
  await renderView();

  screen.getByTestId("automation-toggle-zai").click();

  const writes = calls.filter((request) =>
    ["startAutomation", "stopAutomation"].includes(String(request.type)),
  );
  expect(writes).toEqual([{ type: "startAutomation", kind: "zai" }]);
});

it("stopping the running sub records a stop for that kind", async () => {
  installDispatch({ running: { codex: true } });
  await renderView();

  screen.getByTestId("automation-toggle-codex").click();

  const writes = calls.filter((request) =>
    ["startAutomation", "stopAutomation"].includes(String(request.type)),
  );
  expect(writes).toEqual([{ type: "stopAutomation", kind: "codex" }]);
});

it("shows an unacknowledged rollover on its own sub with its own acknowledge", async () => {
  installDispatch({ running: { codex: true, zai: true }, rolledOver: "zai" });
  await renderView();

  expect(screen.getByTestId("automation-rolled-over-zai")).toBeTruthy();
  expect(screen.queryByTestId("automation-rolled-over-codex")).toBeNull();

  screen.getByTestId("automation-acknowledge-zai").click();
  const acks = calls.filter(
    (request) =>
      request.type === "acknowledgeRollover" && request.kind === "zai",
  );
  expect(acks.length).toBeGreaterThanOrEqual(1);
});
