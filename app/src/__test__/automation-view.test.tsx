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

type Request = {
  readonly type: string;
  readonly kind?: string;
  readonly enabled?: boolean;
  readonly modelId?: string;
};

let calls: Array<Record<string, unknown>>;
let automationReadResolvers: Array<(value: unknown) => void> = [];

function releaseAutomationReads(): void {
  const reply = {
    type: "automation",
    monitors: [monitor("codex"), monitor("zai"), monitor("minimax"), monitor("kimi")],
  };
  for (const resolve of automationReadResolvers.splice(0)) resolve(reply);
}

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
  const kickoffEnabled: Record<string, boolean> = {};
  const kickoffModels: Record<string, string> = {};
  const kickoffResponse = () => ({
    type: "kickoff",
    state: {
      subscriptions: [
        {
          kind: "codex",
          enabled: kickoffEnabled.codex === true,
          modelId: kickoffModels.codex ?? null,
          effectiveModel: kickoffModels.codex ?? "gpt-6-luna",
          effortId: "minimal",
          modelError: null,
          models: [
            {
              id: "gpt-6-luna",
              label: "GPT-6 Luna",
              cheapest: true,
              efforts: [{ id: "minimal", label: "Minimal" }],
            },
            {
              id: "gpt-6.1-sol",
              label: "GPT-6.1 Sol",
              cheapest: false,
              efforts: [{ id: "low", label: "Low" }],
            },
          ],
          nextKickAt: kickoffEnabled.codex ? Date.now() + 3_600_000 : null,
          lastKickAt: null,
          lastAccepted: null,
          lastDetail: null,
        },
        {
          kind: "zai",
          enabled: kickoffEnabled.zai === true,
          modelId: kickoffModels.zai ?? null,
          effectiveModel: kickoffModels.zai ?? "glm-5.3-flash",
          effortId: "low",
          modelError: null,
          models: [
            {
              id: "glm-5.3",
              label: "GLM-5.3",
              cheapest: false,
              efforts: [{ id: "low", label: "Low" }],
            },
            {
              id: "glm-5.3-flash",
              label: "GLM-5.3 Flash",
              cheapest: true,
              efforts: [{ id: "low", label: "Low" }],
            },
          ],
          nextKickAt: kickoffEnabled.zai ? Date.now() + 3_600_000 : null,
          lastKickAt: null,
          lastAccepted: null,
          lastDetail: null,
        },
      ],
      scheduler: { supported: true, installed: false },
    },
  });
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
        case "kickoffState":
          return kickoffResponse();
        case "setKickoffEnabled":
          kickoffEnabled[request.kind as string] = request.enabled === true;
          return kickoffResponse();
        case "setKickoffModel":
          kickoffModels[request.kind as string] = request.modelId as string;
          return kickoffResponse();
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
  releaseAutomationReads();
  delete (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__;
  cleanup();
});

it("uses a shaped monitor-card skeleton until the first read completes", async () => {
  automationReadResolvers = [];
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: ({ request }: { request: Request }) => {
      if (request.type === "openCodeSubscriptions") {
        return { type: "openCodeSubscriptions", subscriptions: [] };
      }
      if (request.type === "automationState") {
        return new Promise((resolve: (value: unknown) => void) => {
          automationReadResolvers.push(resolve);
        });
      }
      if (request.type === "kickoffState") {
        return {
          type: "kickoff",
          state: { subscriptions: [], scheduler: { supported: false, installed: false } },
        };
      }
      return {
        type: "failure",
        error: { kind: "protocolMismatch", message: `unexpected request ${request.type}` },
      };
    },
  };
  const { AutomationView } = await import("~/components/views/automation-view");
  render(
    createElement(AutomationView as ComponentType<{ visible: boolean }>, {
      visible: true,
    }),
  );

  const skeleton = await screen.findByTestId("automation-loading-skeleton");
  expect(skeleton.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(8);
  expect(screen.queryByText("Checking the monitors…")).toBeNull();

  releaseAutomationReads();
  expect(await screen.findByTestId("automation-panel-codex")).toBeTruthy();
  expect(screen.queryByTestId("automation-loading-skeleton")).toBeNull();
});

it("gives every connected sub its own monitor card with its own status", async () => {
  installDispatch({ running: { codex: true } });
  await renderView();

  expect(screen.getByTestId("automation-panel-codex")).toBeTruthy();
  expect(screen.getByTestId("automation-panel-zai")).toBeTruthy();
  expect(screen.getByTestId("automation-panel-codex").contains(
    screen.getByTestId("kickoff-model-codex"),
  )).toBe(true);
  expect(screen.getByTestId("automation-panel-zai").contains(
    screen.getByTestId("kickoff-model-zai"),
  )).toBe(true);

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
