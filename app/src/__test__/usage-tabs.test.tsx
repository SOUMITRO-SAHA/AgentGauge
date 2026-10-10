/**
 * The tab row must survive its own count changing.
 *
 * Subscriptions arrive after mount, so the panel renders Codex alone first and
 * then the connected plans. A hook called per tab inside the render loop is a
 * Rules-of-Hooks violation that only fires on that second render — the window
 * goes blank the moment a second plan connects. This test reproduces the
 * arrival so the crash cannot come back unnoticed.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";

import { UsageTabs } from "~/components/usage/usage-tabs";

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

it("renders the tab set that arrives after mount without crashing", async () => {
  installDispatch();

  render(createElement(UsageTabs, { nowMs: Date.now() }));

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
