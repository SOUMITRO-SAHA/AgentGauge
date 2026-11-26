/**
 * The tab row must survive its own count changing.
 *
 * Subscriptions arrive after mount, so the panel renders Codex alone first and
 * then the connected plans. A hook called per tab inside the render loop is a
 * Rules-of-Hooks violation that only fires on that second render — the window
 * goes blank the moment a second plan connects. This test reproduces the
 * arrival so the crash cannot come back unnoticed.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Request = { readonly type: string; readonly provider?: string };

function snapshot(provider: string, plan: string) {
  const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
  const fiveHour = {
    label: "5h",
    usedPercent: 20,
    durationMins: 300,
    resetsAt,
    remainingPercent: 80,
  };
  return {
    provider,
    freshness: "live",
    fetchedAt: Date.now(),
    source: "test harness",
    reason: null,
    plan,
    permission: "allowed",
    fiveHour,
    weekly: null,
    windows: [fiveHour],
  };
}

function installDispatch(): void {
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: ({ request }: { request: Request }) => {
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
              {
                providerId: "alibaba-coding-plan",
                name: "Alibaba Coding Plan",
                label: "Alibaba Coding Plan",
                integration: null,
                credential: "stored",
                apiBase: null,
              },
            ],
          };
        case "readUsageFor":
          return {
            type: "usage",
            snapshots: [
              snapshot(
                request.provider === "zai" ? "zai" : "codex",
                request.provider === "zai" ? "pro" : "team",
              ),
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

afterEach(() => {
  delete (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__;
  cleanup();
});

// Each test gets a fresh atom world: the atoms are module singletons, and a
// cliDetection read cached by an earlier test would answer every later one.
let renderUsageTabs: (props: { readonly nowMs: number }) => void;
beforeEach(async () => {
  vi.resetModules();
  const { UsageTabs } = await import("~/components/usage/usage-tabs");
  renderUsageTabs = (props) => render(createElement(UsageTabs, props));
});

function installAntigravityDispatch(): void {
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: ({ request }: { request: Request }) => {
      switch (request.type) {
        case "openCodeSubscriptions":
          return { type: "openCodeSubscriptions", subscriptions: [] };
        case "cliDetection":
          return {
            type: "cliDetections",
            tools: [
              {
                tool: "antigravity",
                displayName: "Antigravity CLI",
                executable: "agy",
                installed: true,
                version: "1.5.17",
                reason: null,
              },
            ],
          };
        case "readUsageFor":
          return {
            type: "usage",
            snapshots:
              request.provider === "antigravity"
                ? [
                    {
                      provider: "antigravity",
                      freshness: "live",
                      fetchedAt: Date.now(),
                      source: "antigravity cli",
                      reason: null,
                      plan: null,
                      permission: "allowed",
                      fiveHour: null,
                      weekly: null,
                      windows: [
                        {
                          label: "Gemini weekly",
                          usedPercent: 25,
                          durationMins: 10080,
                          resetsAt: Math.floor(Date.now() / 1000) + 6 * 86400,
                          remainingPercent: 75,
                        },
                        {
                          label: "Gemini 5h",
                          usedPercent: 0,
                          durationMins: 300,
                          resetsAt: Math.floor(Date.now() / 1000) + 4 * 3600,
                          remainingPercent: 100,
                        },
                        {
                          label: "Claude & GPT weekly",
                          usedPercent: 0,
                          durationMins: 10080,
                          resetsAt: Math.floor(Date.now() / 1000) + 6 * 86400,
                          remainingPercent: 100,
                        },
                        {
                          label: "Claude & GPT 5h",
                          usedPercent: 0,
                          durationMins: 300,
                          resetsAt: Math.floor(Date.now() / 1000) + 5 * 3600,
                          remainingPercent: 100,
                        },
                      ],
                    },
                  ]
                : [snapshot("codex", "team")],
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

it("renders the tab set that arrives after mount without crashing", async () => {
  installDispatch();

  renderUsageTabs({ nowMs: Date.now() });

  expect(
    await screen.findByTestId("usage-tab-zai"),
  ).toBeTruthy();
  expect(screen.getByTestId("usage-tab-alibaba-coding-plan")).toBeTruthy();

  const plan = await screen.findByTestId("plan");
  expect(plan.textContent).toBe("Team");

  await waitFor(() => {
    expect(screen.queryByTestId("usage-skeleton")).toBeNull();
  });

  await waitFor(() => {
    expect(screen.queryByTestId("usage-skeleton")).toBeNull();
  });
});

it("shows the detected Antigravity CLI as a tab with its quota windows", async () => {
  installAntigravityDispatch();

  renderUsageTabs({ nowMs: Date.now() });

  const tab = await screen.findByTestId("usage-tab-antigravity");
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);

  await waitFor(() => {
    expect(screen.queryByTestId("usage-skeleton")).toBeNull();
  });

  const bars = screen.getAllByTestId("window-bar");
  expect(bars.length).toBe(4);

  const pointer = screen.getByTestId("usage-antigravity-pointer");
  expect(pointer.textContent).toContain("Stats view");
});
