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

function codexSnapshot() {
  const resetsAt = Math.floor(Date.now() / 1000) + 7_200;
  const fiveHour = {
    label: "5h",
    usedPercent: 32,
    durationMins: 300,
    resetsAt,
    remainingPercent: 68,
  };
  const weekly = {
    label: "weekly",
    usedPercent: 11,
    durationMins: 10_080,
    resetsAt: resetsAt + 345_600,
    remainingPercent: 89,
  };
  return {
    provider: "codex",
    freshness: "live",
    fetchedAt: Date.now(),
    source: "codex app-server",
    reason: null,
    plan: "pro",
    permission: "allowed",
    fiveHour,
    weekly,
    windows: [fiveHour, weekly],
  };
}

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

function codexAccountUsage() {
  return {
    fetchedAt: 1_791_561_935_000,
    summary: {
      totalTokens: 1234567,
      peakDailyTokens: 45678,
      longestRunningTurnSec: 540,
      currentStreakDays: 8,
      longestStreakDays: 14,
      totalRequests: null,
    },
    windowDays: null,
    dailyUsageBuckets: [{ startDate: "2026-10-07", tokens: 2300 }],
  };
}

function zaiAccountUsage() {
  return {
    fetchedAt: 1_791_561_935_000,
    summary: {
      totalTokens: 21_700_000_000,
      peakDailyTokens: 1_860_000_000,
      longestRunningTurnSec: null,
      currentStreakDays: 5,
      longestStreakDays: 9,
      totalRequests: 10_419,
    },
    windowDays: 30,
    dailyUsageBuckets: [
      { startDate: "2026-10-08", tokens: 1_470_000_000 },
      { startDate: "2026-10-09", tokens: 275_000_000 },
    ],
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
            usage:
              request.provider === "zai" ? zaiAccountUsage() : codexAccountUsage(),
          };
        case "readUsageFor":
          return {
            type: "usage",
            snapshots:
              request.provider === "zai"
                ? [zaiSnapshot()]
                : request.provider === "codex"
                  ? [codexSnapshot()]
                  : [],
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
  expect(await screen.findByTestId("stats-total-tokens")).toBeTruthy();
});

it("shows Codex's window reading below its analytics, like Z.AI's tab", async () => {
  installDispatch();

  render(createElement(StatsView, { visible: true }));

  expect(
    await screen.findByTestId("stats-account-analytics"),
  ).toBeTruthy();
  expect(await screen.findByTestId("stats-plan-reading")).toBeTruthy();

  const plan = screen.getByTestId("stats-plan-name");
  expect(plan.textContent).toBe("Pro");
  const fiveHour = await screen.findByTestId("stats-plan-window-used-5h");
  expect(fiveHour.textContent).toContain("32% used");
  const weekly = await screen.findByTestId("stats-plan-window-used-weekly");
  expect(weekly.textContent).toContain("11% used");
});

it("reads token counts compact, previews exact on hover, pins on click", async () => {
  installDispatch();

  render(createElement(StatsView, { visible: true }));

  const total = await screen.findByTestId("stats-total-tokens");
  const peak = screen.getByTestId("stats-peak-daily");
  const digits = (text: string | null) => (text ?? "").replace(/\D/g, "");

  // Big counts open compact; a count under a million stays grouped.
  expect(total.textContent).toMatch(/1[.,]23M/);
  expect(digits(peak.textContent)).toBe("45678");

  // Hover previews the exact number on this card only.
  fireEvent.mouseEnter(total);
  expect(digits(total.textContent)).toBe("1234567");
  expect(digits(peak.textContent)).toBe("45678");
  fireEvent.mouseLeave(total);
  expect(total.textContent).toMatch(/1[.,]23M/);

  // A click pins this card to the exact form — and only this card.
  fireEvent.click(total);
  fireEvent.mouseEnter(total);
  fireEvent.mouseLeave(total);
  expect(digits(total.textContent)).toBe("1234567");
  expect(digits(peak.textContent)).toBe("45678");

  // A second click returns it to compact.
  fireEvent.click(total);
  expect(total.textContent).toMatch(/1[.,]23M/);
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

it("shows Z.AI's token analytics like Codex's, labelled with its window", async () => {
  installDispatch();

  render(createElement(StatsView, { visible: true }));

  fireEvent.mouseDown(screen.getByTestId("stats-tab-zai"));
  fireEvent.click(screen.getByTestId("stats-tab-zai"));

  expect(await screen.findByTestId("stats-plan-analytics")).toBeTruthy();
  expect(await screen.findByTestId("stats-daily-chart")).toBeTruthy();

  const cards = await readAnalyticsCards();
  expect(cards.totalTokens).toMatch(/21[.,]7B/);
  expect(cards.totalRequests).toBe("10419");
});

async function readAnalyticsCards() {
  const totals = await screen.findByTestId("stats-total-tokens");
  const requests = await screen.findByTestId("stats-total-requests");
  return {
    totalTokens: totals.textContent ?? "",
    totalRequests: (requests.textContent ?? "").replace(/\D/g, ""),
  };
}
