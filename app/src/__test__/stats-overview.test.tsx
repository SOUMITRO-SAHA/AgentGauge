/**
 * The All plans overview.
 *
 * This lives in its own file rather than beside the per-plan specs for one
 * reason: the view's atoms are session-retained, so only the first test in a
 * file sees a pending read. The overview is where that state first became
 * observable — it reads every plan's analytics on mount — so it owns a file
 * whose first test is the one that watches a read in flight.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  ActivityHeatmap,
  LocalLogPanel,
  StatsView,
} from "~/components/views/stats-view";

type Request = { readonly type: string; readonly provider?: string };

const PRICE_LIST = {
  meta: { currency: "USD", updated: "2026-10-11" },
  providers: {
    "zai-coding-plan": {
      subscription: { plans: [{ name: "Pro", price_usd_per_month: 80 }] },
      models: {
        "glm-5.3": { api_cost_per_million: { input: 1.4, output: 4.4 } },
      },
    },
  },
};

function zaiSnapshot() {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  return {
    provider: "zai",
    freshness: "live",
    fetchedAt: Date.now(),
    source: "z.ai coding plan",
    reason: null,
    plan: "pro",
    permission: "allowed",
    windows: [
      {
        label: "5h",
        usedPercent: 16,
        durationMins: 300,
        resetsAt,
        remainingPercent: 84,
      },
    ],
    fiveHour: null,
    weekly: null,
    extra: null,
  };
}

function codexSnapshot() {
  const resetsAt = Math.floor(Date.now() / 1000) + 7200;
  return {
    provider: "codex",
    freshness: "live",
    fetchedAt: Date.now(),
    source: "codex app-server",
    reason: null,
    plan: "pro",
    permission: "allowed",
    windows: [
      {
        label: "weekly",
        usedPercent: 11,
        durationMins: 10080,
        resetsAt: resetsAt + 345_600,
        remainingPercent: 89,
      },
    ],
    fiveHour: null,
    weekly: null,
    extra: null,
  };
}

function zaiAccountUsage() {
  return {
    fetchedAt: Date.now(),
    summary: {
      totalTokens: 21_700_000_000,
      peakDailyTokens: 1_860_000_000,
      longestRunningTurnSec: null,
      currentStreakDays: 5,
      longestStreakDays: 9,
      totalRequests: 10_419,
    },
    windowDays: 30,
    dailyUsageBuckets: [{ startDate: "2026-10-08", tokens: 1_470_000_000 }],
    models: [
      {
        id: "glm-5.3",
        displayName: "GLM-5.3",
        tokens: 21_700_000_000,
        requests: null,
      },
    ],
    local: null,
  };
}

function codexAccountUsage() {
  return {
    fetchedAt: Date.now(),
    summary: {
      totalTokens: 1_234_567,
      peakDailyTokens: 45_678,
      longestRunningTurnSec: 540,
      currentStreakDays: 8,
      longestStreakDays: 14,
      totalRequests: null,
    },
    windowDays: null,
    dailyUsageBuckets: [{ startDate: "2026-10-07", tokens: 2300 }],
    models: [],
    local: {
      projects: [],
      models: [
        {
          id: "gpt-5.5",
          displayName: "GPT-5.5",
          input: 132_064_094,
          cachedInput: 125_855_104,
          cacheWrite: 0,
          output: 616_260,
          reasoning: 400_000,
          responses: 1146,
          costUsd: 112.46,
        },
      ],
      days: [{ day: "2026-09-24", tokens: 132_680_354 }],
      costUsd: 112.46,
      unpricedTokens: 1_100_000,
      sessions: 168,
      filesScanned: 168,
      filesUnreadable: 0,
      filesCompressed: 0,
      firstDay: "2026-09-24",
      lastDay: "2026-09-24",
    },
  };
}

function subscriptionsReply() {
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
}

const pending = new Map<string, () => void>();

function installDeferredDispatch(): { releaseAll: () => void } {
  const hold = (key: string, payload: unknown) =>
    new Promise((resolve) => pending.set(key, () => resolve(payload)));
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: ({ request }: { request: Request }) => {
      if (request.type === "readAccountUsage") {
        return hold(`account:${request.provider ?? ""}`, {
          type: "accountUsage",
          usage:
            request.provider === "zai" ? zaiAccountUsage() : codexAccountUsage(),
        });
      }
      if (request.type === "readUsageFor") {
        return hold(`usage:${request.provider ?? ""}`, {
          type: "usage",
          snapshots:
            request.provider === "zai" ? [zaiSnapshot()] : [codexSnapshot()],
        });
      }
      return subscriptionsReply();
    },
  };
  return {
    releaseAll: () => {
      for (const release of pending.values()) release();
      pending.clear();
    },
  };
}

function installDispatch(): void {
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: ({ request }: { request: Request }) => {
      switch (request.type) {
        case "openCodeSubscriptions":
          return subscriptionsReply();
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
              request.provider === "zai" ? [zaiSnapshot()] : [codexSnapshot()],
          };
        default:
          return {
            type: "failure",
            error: { kind: "protocolMismatch", message: "unexpected" },
          };
      }
    },
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => PRICE_LIST })),
  );
});

afterEach(() => {
  for (const release of pending.values()) release();
  pending.clear();
  delete (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__;
  vi.unstubAllGlobals();
  cleanup();
});

it("stands in for a plan still reading instead of claiming it has no history", async () => {
  const release = installDeferredDispatch();

  render(createElement(StatsView, { visible: true }));

  const row = await screen.findByTestId("stats-plan-row-zai");
  // A row whose read is in flight must not read as "No token history" — that
  // is the state where a provider simply has not answered yet.
  expect(within(row).getByTestId("stats-plan-row-zai-tokens").textContent).toBe(
    "Reading…",
  );
  expect(
    within(row).getByTestId("stats-plan-row-zai-cost").textContent,
  ).toBe("Reading…");

  release.releaseAll();
  await waitFor(() =>
    expect(
      within(row).getByTestId("stats-plan-row-zai-tokens").textContent,
    ).not.toBe("Reading…"),
  );
});

it("lists every readable plan with its own window, tokens and cost", async () => {
  installDispatch();

  render(createElement(StatsView, { visible: true }));

  const overview = await screen.findByTestId("stats-all-plans");
  expect(overview).toBeTruthy();
  expect(screen.getByTestId("stats-plan-row-codex")).toBeTruthy();
  expect(screen.getByTestId("stats-plan-row-zai")).toBeTruthy();

  // Z.AI reports its own history over a 30-day window; Codex's comes from
  // this machine's logs over a span the panel states. Different claims, so
  // each row names its own rather than both claiming "tokens".
  expect(
    screen.getByTestId("stats-plan-row-zai-source").textContent,
  ).toContain("30 days");
  const codexRow = screen.getByTestId("stats-plan-row-codex");
  expect(within(codexRow).getByTestId("stats-plan-row-codex-source").textContent).toContain(
    "2026-09-24",
  );
  expect(
    within(codexRow).getByTestId("stats-plan-row-codex-cost").textContent,
  ).toContain("$112");
  expect(
    screen.getByTestId("stats-plan-row-zai-window").textContent,
  ).toContain("Pro");

  // A provider-reported plan is priced from its own model mix, so a plan whose
  // numbers come from the vendor is not left with a bare dash beside a dollar
  // figure on the row above. Both are estimates of the same kind and are
  // labelled the same way.
  const zaiCost = screen.getByTestId("stats-plan-row-zai-cost").textContent;
  expect(zaiCost).not.toBe("—");
  expect(zaiCost).toMatch(/\$|tokens/);
  expect(screen.getByTestId("stats-plan-row-zai-cost-basis").textContent).toMatch(
    /price list|estimate/i,
  );
  expect(screen.getByTestId("stats-plan-row-zai-cost-basis").textContent).toContain(
    "80% input / 20% output",
  );
  expect(screen.getByTestId("stats-plan-row-zai-cost-basis").textContent).toContain(
    "2026-10-11",
  );
  expect(screen.getByTestId("stats-plan-row-codex-cost-basis").textContent).toContain(
    "2026-10-11",
  );
  expect(screen.getByTestId("stats-plan-row-codex-cost-basis").textContent).toContain(
    "1.1M tokens remain unpriced",
  );
  const codexRequests = screen.getByTestId("stats-plan-row-codex-requests").textContent ?? "";
  expect(codexRequests.replace(/\D/g, "")).toBe("1146");

  // Both rows state where they were read from in the same shape, so the two
  // plans are comparable at a glance rather than by decoding two conventions.
  expect(
    screen.getByTestId("stats-plan-row-codex-source").textContent,
  ).toMatch(/local sessions/);
  expect(screen.getByTestId("stats-plan-row-zai-source").textContent).toMatch(
    /provider window/,
  );
  expect(screen.getByTestId("stats-plan-row-zai-peak").textContent).toContain(
    "2026-10-08",
  );

  // Nothing is summed across spans that do not match.
  expect(screen.queryByTestId("stats-all-plans-total")).toBeNull();
  const note = screen.getByTestId("stats-all-plans-not-summed");
  expect(note.textContent ?? "").toContain("window");
  expect(note.textContent ?? "").toContain("summed");
});

it("opens a plan's own tab from the overview's tab strip", async () => {
  installDispatch();

  render(createElement(StatsView, { visible: true }));

  const tab = await screen.findByTestId("stats-tab-zai");
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);

  expect(await screen.findByTestId("stats-plan-analytics")).toBeTruthy();
});

it("draws the activity heatmap over the span the logs actually cover", () => {
  render(
    createElement(LocalLogPanel, {
      usage: {
        ...codexAccountUsage().local,
        days: [
          { day: "2026-09-22", tokens: 100 },
          { day: "2026-09-23", tokens: 0 },
          // A gap: no record at all for the 24th.
          { day: "2026-09-25", tokens: 400 },
        ],
        firstDay: "2026-09-22",
        lastDay: "2026-09-26",
      },
      source: "Codex",
    }),
  );

  const heatmap = screen.getByTestId("stats-activity-heatmap");
  // The grid spans the coverage, and says which span it is.
  expect(heatmap.textContent ?? "").toContain("2026-09-22");
  expect(heatmap.textContent ?? "").toContain("2026-09-26");
  // A day with no record is a gap, distinct from a day with no tokens.
  expect(screen.getByTestId("stats-activity-cell-2026-09-24")).toBeTruthy();
  expect(
    screen.getByTestId("stats-activity-cell-2026-09-24").dataset.state,
  ).toBe("no-record");
  // A day that recorded zero tokens is not a day with no record: the two are
  // drawn differently, so a missing log never reads as an idle one.
  expect(
    screen.getByTestId("stats-activity-cell-2026-09-23").dataset.state,
  ).toBe("empty");
  // The busiest day in range is the top of the scale.
  expect(
    screen.getByTestId("stats-activity-cell-2026-09-25").dataset.state,
  ).toBe("peak");
  expect(screen.getByTestId("stats-activity-busiest")).toBeTruthy();
});

it("leaves the heatmap out when the logs have no day records", () => {
  render(
    createElement(LocalLogPanel, {
      usage: { ...codexAccountUsage().local, days: [] },
      source: "Codex",
    }),
  );

  expect(screen.queryByTestId("stats-activity-heatmap")).toBeNull();
});

it("draws the heatmap from a provider's own daily series too", async () => {
  installDispatch();

  render(createElement(StatsView, { visible: true }));

  const tab = await screen.findByTestId("stats-tab-zai");
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);

  // Z.AI reports 30 days of its own. A heatmap fed only from local logs
  // would leave the tab a Z.AI user actually lives on with no activity view
  // at all, even though the data is right there in its daily buckets.
  const heatmap = await screen.findByTestId("stats-activity-heatmap");
  expect(heatmap).toBeTruthy();

  const source = screen.getByTestId("stats-activity-source");
  expect(source.textContent ?? "").toContain("Z.AI");
  expect(source.textContent ?? "").toContain("30 days");
  expect(screen.getByTestId("stats-activity-cell-2026-10-08")).toBeTruthy();
});

it("does not stack two heatmaps on a tab that has both series", async () => {
  installDispatch();

  render(createElement(StatsView, { visible: true }));

  const tab = await screen.findByTestId("stats-tab-zai");
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);

  // One activity view per tab: the provider's series when it reports one,
  // the local logs otherwise, never both stacked.
  await screen.findByTestId("stats-activity-heatmap");
  expect(
    document.querySelectorAll("[data-testid='stats-activity-heatmap']").length,
  ).toBe(1);
});

it("ranks projects by tokens and shows cost only where it is known", () => {
  render(
    createElement(LocalLogPanel, {
      usage: {
        ...codexAccountUsage().local,
        projects: [
          {
            name: "widget",
            input: 400,
            output: 40,
            responses: 8,
            costUsd: 1.25,
          },
          {
            name: "bookmark-hub",
            input: 900,
            output: 100,
            responses: 20,
            costUsd: null,
          },
        ],
      },
      source: "Codex",
    }),
  );

  const rows = screen.getAllByTestId("stats-project-row");
  // Ranked by tokens, so the heavier project leads regardless of input order.
  expect(rows[0].textContent ?? "").toContain("bookmark-hub");
  expect(rows[1].textContent ?? "").toContain("widget");

  // An unpriced project shows tokens, never a $0 that reads as free.
  expect(rows[0].textContent ?? "").not.toContain("$0");
  expect(rows[0].textContent ?? "").toContain("1,000 tokens");
  expect(rows[1].textContent ?? "").toContain("$1.25");
});

it("shows no leaderboard when the source records no working directory", () => {
  render(
    createElement(LocalLogPanel, {
      usage: { ...codexAccountUsage().local, projects: [] },
      source: "Codex",
    }),
  );

  expect(screen.queryByTestId("stats-projects")).toBeNull();
});

it("lays activity out as week columns the way a contribution graph does", () => {
  render(
    createElement(ActivityHeatmap, {
      days: [
        { day: "2026-09-23", tokens: 100 },
        { day: "2026-10-05", tokens: 400 },
        { day: "2026-10-06", tokens: 0 },
      ],
      until: "2026-10-07",
    }),
  );

  // A column is a week and a row is a weekday, so every day in the grid sits
  // in the row its weekday demands. That alignment is the whole shape of the
  // view: a wrapping row of days cannot show a rhythm.
  const grid = screen.getByTestId("stats-activity-grid");
  for (const day of ["2026-09-23", "2026-10-05", "2026-10-06"]) {
    const cell = within(grid).getByTestId(`stats-activity-cell-${day}`);
    // Rows run Monday first, so the calendar's Sunday-first index is rotated.
    const mondayFirst = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
    expect(cell.dataset.row).toBe(String(mondayFirst));
  }

  // Weeks are grid columns rather than elements, so they are counted as seven
  // days apiece. The grid shortens the window rather than scrolling sideways,
  // so the exact count follows the frame it is given — here whatever the test
  // environment reports. The responsive bounds are the contract; the count at
  // a real width belongs to the e2e.
  const days = within(grid).getAllByTestId(/^stats-activity-cell-2026/);
  const weeks = days.length / 7;
  expect(weeks).toBeGreaterThanOrEqual(13);
  expect(weeks).toBeLessThanOrEqual(53);

  // Month labels, so a column of weeks is findable in time.
  const months = screen.getByTestId("stats-activity-months").textContent ?? "";
  expect(months).toContain("Oct");
  expect(months).toContain("Sep");
});

it("still separates a day with no record from a day that recorded nothing", () => {
  render(
    createElement(ActivityHeatmap, {
      days: [
        { day: "2026-10-05", tokens: 400 },
        { day: "2026-10-06", tokens: 0 },
      ],
      until: "2026-10-07",
    }),
  );

  // A gap in the logs and a day you did not work mean opposite things. The
  // contribution-graph look does not erase that.
  expect(
    screen.getByTestId("stats-activity-cell-2026-10-06").dataset.state,
  ).toBe("empty");
  expect(
    screen.getByTestId("stats-activity-cell-2026-09-30").dataset.state,
  ).toBe("no-record");
  expect(screen.getByTestId("stats-activity-cell-2026-10-05").dataset.state).toBe(
    "peak",
  );
});
