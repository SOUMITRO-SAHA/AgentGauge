/**
 * Stats must carry every connected plan, with analytics already on.
 *
 * Local analytics is a preference that defaults on, so the view may never
 * render a consent gate first: the token activity reads as soon as the view is
 * shown. The tab set mirrors the connected subscriptions — Codex always, plus
 * every plan OpenCode reports — and a plan whose reading exists shows it under
 * its own tab.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";

import { StatsView } from "~/components/views/stats-view";

type Request = { readonly type: string; readonly provider?: string };

function zaiSnapshot() {
  const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
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
        case "readAccountUsage":
          return {
            type: "accountUsage",
            usage: {
              fetchedAt: 1_791_561_935_000,
              summary: {
                lifetimeTokens: 1234567,
                peakDailyTokens: 45678,
                longestRunningTurnSec: 540,
                currentStreakDays: 8,
                longestStreakDays: 14,
              },
              dailyUsageBuckets: [
                { startDate: "2026-10-07", tokens: 2300 },
              ],
            },
          };
        case "readUsageFor":
          return {
            type: "usage",
            snapshots: request.provider === "zai" ? [zaiSnapshot()] : [],
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

it("renders analytics immediately, with no consent gate", async () => {
  installDispatch();

  render(createElement(StatsView, { visible: true }));

  expect(
    await screen.findByTestId("stats-account-analytics"),
  ).toBeTruthy();
  expect(screen.queryByTestId("stats-analytics-consent")).toBeNull();
  expect(await screen.findByTestId("stats-lifetime-tokens")).toBeTruthy();
});

it("gives every connected plan a tab and shows its stats there", async () => {
  installDispatch();

  render(createElement(StatsView, { visible: true }));

  expect(await screen.findByTestId("stats-tab-codex")).toBeTruthy();
  expect(await screen.findByTestId("stats-tab-zai")).toBeTruthy();
  expect(
    screen.getByTestId("stats-tab-alibaba-coding-plan"),
  ).toBeTruthy();

  fireEvent.mouseDown(screen.getByTestId("stats-tab-zai"));
  fireEvent.click(screen.getByTestId("stats-tab-zai"));

  expect(await screen.findByTestId("stats-plan-reading")).toBeTruthy();
  expect(screen.getByTestId("stats-plan-name").textContent).toBe("Pro");
  const used = await screen.findByTestId("stats-plan-window-used-5h");
  expect(used.textContent).toContain("16% used");

  fireEvent.mouseDown(screen.getByTestId("stats-tab-alibaba-coding-plan"));
  fireEvent.click(screen.getByTestId("stats-tab-alibaba-coding-plan"));
  expect(await screen.findByTestId("stats-plan-unreadable")).toBeTruthy();
});
