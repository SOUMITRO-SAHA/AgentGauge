/**
 * Stats must carry every connected plan, with analytics already on.
 *
 * Local analytics is a preference that defaults on, so the view may never
 * render a consent gate first: the token activity reads as soon as the view is
 * shown. The tab set mirrors the connected subscriptions — Codex always, plus
 * every plan OpenCode reports — and a plan whose reading exists shows it under
 * its own tab.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import * as Atom from "effect/unstable/reactivity/Atom";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { statsTabAtom } from "~/atoms";
import {
  LocalLogPanel,
  ModelMixBlock,
  StatsView,
  tokenTooltipFormatter,
} from "~/components/views/stats-view";
import type { PriceList } from "~/lib/pricing";

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
    models: [],
    local: {
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
        {
          id: "gpt-6-luna",
          displayName: "GPT-6 Luna",
          input: 137_116_712,
          cachedInput: 133_943_168,
          cacheWrite: 0,
          output: 780_596,
          reasoning: 300_000,
          responses: 1080,
          costUsd: 2.05,
        },
        {
          id: "gpt-5.5-preview",
          displayName: "gpt-5.5-preview",
          input: 1_000_000,
          cachedInput: 900_000,
          cacheWrite: 0,
          output: 100_000,
          reasoning: 0,
          responses: 10,
          costUsd: null,
        },
      ],
      days: [
        { day: "2026-09-04", tokens: 120_000_000 },
        { day: "2026-09-24", tokens: 180_000_000 },
      ],
      costUsd: 114.51,
      unpricedTokens: 1_100_000,
      sessions: 168,
      filesScanned: 168,
      filesUnreadable: 0,
      filesCompressed: 0,
      firstDay: "2026-09-04",
      lastDay: "2026-09-24",
    },
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
    models: [
      {
        id: "glm-5.3",
        displayName: "GLM-5.3",
        tokens: 8_472_310_570,
        requests: null,
      },
      {
        id: "glm-5.3-flash",
        displayName: "GLM-5.3-Flash",
        tokens: 13_227_689_430,
        requests: null,
      },
    ],
    local: null,
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
}

function installDispatch(overrides?: {
  readonly zaiUsage?: unknown;
  readonly codexUsage?: unknown;
}): void {
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: ({ request }: { request: Request }) => {
      switch (request.type) {
        case "openCodeSubscriptions":
          return subscriptionsReply();
        case "readAccountUsage":
          return {
            type: "accountUsage",
            usage:
              request.provider === "zai"
                ? (overrides?.zaiUsage ?? zaiAccountUsage())
                : (overrides?.codexUsage ?? codexAccountUsage()),
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

/**
 * Every deferred dispatcher registers its releases here, and `afterEach`
 * flushes them: a test that fails mid-assertion must not leave a held read
 * behind, because the retained atoms would hand that pending state to every
 * later test in this file.
 */
const deferredReleases: Array<() => void> = [];

afterEach(() => {
  Atom.set(statsTabAtom, "codex");
  for (const release of deferredReleases.splice(0)) release();
  delete (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__;
  vi.unstubAllGlobals();
  cleanup();
});

/**
 * The bundled price list, served through the same fetch the app uses. Only
 * the Z.AI slice matters to these tests; the estimator's own suite covers
 * the rest of the catalog.
 */
const PRICE_LIST: PriceList = {
  meta: { currency: "USD", updated: "2026-10-11" },
  providers: {
    "zai-coding-plan": {
      subscription: { plans: [{ name: "Pro", price_usd_per_month: 80 }] },
      models: {
        "glm-5.3": { api_cost_per_million: { input: 1.4, output: 4.4 } },
        "glm-5.3-flash": { api_cost_per_million: { input: 0.15, output: 0.5 } },
      },
    },
  },
} as unknown as PriceList;

function stubPriceList(list: PriceList = PRICE_LIST): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => list })),
  );
}

/**
 * The price list must be stubbed for the whole file, not per test: the atom
 * that loads it is session-retained, so whichever test mounts the model mix
 * first decides the result every later test sees (the same rule the usage
 * atoms follow).
 */
beforeEach(() => {
  stubPriceList();
});

/** Opens the Z.AI tab and waits for its analytics to land. */
async function openZaiAnalytics(): Promise<void> {
  const tab = await screen.findByTestId("stats-tab-zai");
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
  await screen.findByTestId("stats-plan-analytics");
  await screen.findByTestId("stats-model-mix");
}

/**
 * Answers the subscription read at once but holds both usage reads until the
 * test releases them, so a skeleton's brief moment can be asserted. Every
 * release must happen before the test ends: the atoms are session-retained,
 * and a read left pending here would poison every later test in this file.
 */
function installDeferredDispatch(): {
  releaseAccountUsage: (provider: string) => void;
  releaseUsageFor: (provider: string) => void;
  releaseAll: () => void;
} {
  const pending = new Map<string, () => void>();
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
    releaseAccountUsage: (provider) => pending.get(`account:${provider}`)?.(),
    releaseUsageFor: (provider) => pending.get(`usage:${provider}`)?.(),
    releaseAll: () => {
      for (const release of pending.values()) release();
      pending.clear();
    },
  };
}

function registerDeferredDispatch() {
  const deferred = installDeferredDispatch();
  deferredReleases.push(deferred.releaseAll);
  return deferred;
}

it("stands in with a shaped skeleton while the first analytics read runs", async () => {
  const release = registerDeferredDispatch();

  render(createElement(StatsView, { visible: true }));

  expect(await screen.findByTestId("stats-account-analytics")).toBeTruthy();
  const skeleton = await screen.findByTestId("stats-analytics-skeleton");

  // The skeleton mirrors the analytics it becomes: a metric-card row and the
  // daily chart block, so the panel never collapses and snaps back.
  const cards = within(skeleton).getByTestId("stats-analytics-skeleton-cards");
  expect(cards.children.length).toBe(4);
  expect(
    within(skeleton).getByTestId("stats-analytics-skeleton-chart"),
  ).toBeTruthy();

  // The old loading line is gone; a placeholder paragraph reserved nothing.
  expect(screen.queryByText("Reading Codex activity…")).toBeNull();

  release.releaseAccountUsage("codex");
  expect(await screen.findByTestId("stats-total-tokens")).toBeTruthy();
  expect(screen.queryByTestId("stats-analytics-skeleton")).toBeNull();
  release.releaseAll();
});

it("holds both of a plan's panels on shaped skeletons during its first read", async () => {
  const release = registerDeferredDispatch();

  render(createElement(StatsView, { visible: true }));

  fireEvent.mouseDown(await screen.findByTestId("stats-tab-zai"));
  fireEvent.click(screen.getByTestId("stats-tab-zai"));

  const analytics = await screen.findByTestId("stats-plan-analytics");
  expect(
    within(analytics).getByTestId("stats-analytics-skeleton"),
  ).toBeTruthy();

  // The reading skeleton mirrors the reading: freshness pill, the plan's
  // metric cards (plan plus its two windows), and the source line.
  const reading = await screen.findByTestId("stats-reading-skeleton");
  within(reading).getByTestId("stats-reading-skeleton-pill");
  const cards = within(reading).getByTestId("stats-reading-skeleton-cards");
  expect(cards.children.length).toBe(3);
  within(reading).getByTestId("stats-reading-skeleton-source");

  release.releaseAccountUsage("zai");
  release.releaseUsageFor("zai");
  expect(await screen.findByTestId("stats-total-tokens")).toBeTruthy();
  expect(screen.queryByTestId("stats-analytics-skeleton")).toBeNull();
  expect(screen.queryByTestId("stats-reading-skeleton")).toBeNull();
  release.releaseAll();
});

it("shows a revisited tab from its retained reading, without a skeleton", async () => {
  installDispatch();

  render(createElement(StatsView, { visible: true }));

  expect(await screen.findByTestId("stats-total-tokens")).toBeTruthy();

  fireEvent.mouseDown(screen.getByTestId("stats-tab-zai"));
  fireEvent.click(screen.getByTestId("stats-tab-zai"));
  expect(await screen.findByTestId("stats-total-tokens")).toBeTruthy();

  fireEvent.mouseDown(screen.getByTestId("stats-tab-codex"));
  fireEvent.click(screen.getByTestId("stats-tab-codex"));
  expect(await screen.findByTestId("stats-total-tokens")).toBeTruthy();
  expect(screen.queryByTestId("stats-analytics-skeleton")).toBeNull();
  expect(screen.queryByTestId("stats-reading-skeleton")).toBeNull();
});

it("renders analytics immediately, with no consent gate and no opt-out", async () => {
  installDispatch();

  render(createElement(StatsView, { visible: true }));

  expect(
    await screen.findByTestId("stats-account-analytics"),
  ).toBeTruthy();
  expect(screen.queryByTestId("stats-analytics-consent")).toBeNull();
  expect(await screen.findByTestId("stats-total-tokens")).toBeTruthy();

  // Analytics is the product now: no off switch anywhere on the screen.
  expect(screen.queryByTestId("stats-disable-analytics")).toBeNull();
  expect(screen.queryByTestId("stats-enable-analytics")).toBeNull();
  expect(screen.queryByTestId("stats-analytics-off")).toBeNull();
  expect(screen.queryByText("Turn off analytics")).toBeNull();
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

it("reads token counts compact, keeps them compact on hover, toggles on press", async () => {
  installDispatch();

  render(createElement(StatsView, { visible: true }));

  const total = await screen.findByTestId("stats-total-tokens");
  const peak = screen.getByTestId("stats-peak-daily");
  const digits = (text: string | null) => (text ?? "").replace(/\D/g, "");

  // Big counts open compact; a count under a million stays grouped.
  expect(total.textContent).toMatch(/1[.,]23M/);
  expect(digits(peak.textContent)).toBe("45678");

  // Hovering only tints the card; the number never switches under the pointer.
  fireEvent.mouseEnter(total);
  expect(total.textContent).toMatch(/1[.,]23M/);
  expect(digits(peak.textContent)).toBe("45678");
  fireEvent.mouseLeave(total);

  // The hover affordance is the chart's primary colour.
  expect(total.className).toContain("hover:text-chart-1");

  // A press pins this card to the exact form — and only this card.
  fireEvent.click(total);
  expect(digits(total.textContent)).toBe("1234567");
  expect(digits(peak.textContent)).toBe("45678");

  // A second press returns it to compact.
  fireEvent.click(total);
  expect(total.textContent).toMatch(/1[.,]23M/);
});

it("reads the day's tokens in the chart tooltip exactly, with the compact beside", () => {
  const row = tokenTooltipFormatter(38_289_865);
  const { container } = render(createElement("div", null, row));
  const text = container.textContent ?? "";
  const digits = (value: string) => value.replace(/\D/g, "");

  // The exact grouped number first, the compact form in brackets beside it.
  expect(text).toContain("Tokens");
  expect(text).toContain("(38.29M)");
  expect(digits(text)).toBe("382898653829");

  // The label and value sit in a spaced row — "Tokens3,82" was the bug.
  expect(container.querySelector("div.gap-2")).toBeTruthy();
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

it("shows the model mix with token shares and API-equivalent estimates", async () => {
  installDispatch();

  render(createElement(StatsView, { visible: true }));
  await openZaiAnalytics();

  // The vendor's ranking leads: GLM-5.3 is sortOrder 1 even though Flash
  // carried more tokens.
  const glm = screen.getByTestId("stats-model-row-glm-5.3");
  expect(within(glm).getByText("GLM-5.3")).toBeTruthy();
  expect(within(glm).getByText("39% of tokens")).toBeTruthy();
  expect(within(glm).getByText("85% of est. cost")).toBeTruthy();

  const flash = screen.getByTestId("stats-model-row-glm-5.3-flash");
  expect(within(flash).getByText("61% of tokens")).toBeTruthy();
  expect(within(flash).getByText("15% of est. cost")).toBeTruthy();

  // 8.47B at $2.00/M + 13.23B at $0.22/M ≈ $19,855, ≈ 248× the $80 Pro plan.
  const cost = screen.getByTestId("stats-est-cost");
  expect(cost.textContent ?? "").toMatch(/19[.,]855/);
  const ratio = screen.getByTestId("stats-value-ratio");
  expect(ratio.textContent ?? "").toContain("248");

  const source = screen.getByTestId("stats-model-mix-source");
  expect(source.textContent ?? "").toContain("price list 2026-10-11");
  expect(source.textContent ?? "").toContain("80% input");
  expect(screen.queryByTestId("stats-unpriced-tokens")).toBeNull();
});

it("counts models without a reference price as tokens, never as $0", () => {
  render(
    createElement(ModelMixBlock, {
      kind: "zai",
      models: [
        { id: "glm-5.3", displayName: "GLM-5.3", tokens: 1_000_000, requests: null },
        { id: "glm-next", displayName: "GLM Next", tokens: 9_000_000, requests: null },
      ],
      windowDays: 30,
      plan: "pro",
      pricingState: "ready",
      priceList: PRICE_LIST,
    }),
  );

  const unpriced = screen.getByTestId("stats-model-row-glm-next");
  expect(within(unpriced).getByText("No reference price")).toBeTruthy();
  expect(
    within(screen.getByTestId("stats-model-row-glm-5.3")).queryByText(
      "No reference price",
    ),
  ).toBeNull();

  const note = screen.getByTestId("stats-unpriced-tokens");
  expect((note.textContent ?? "").replace(/\D/g, "")).toBe("9000000");
});

it("keeps the model mix honest when the price list cannot be read", () => {
  render(
    createElement(ModelMixBlock, {
      kind: "zai",
      models: [
        { id: "glm-5.3", displayName: "GLM-5.3", tokens: 1_000, requests: null },
      ],
      windowDays: 30,
      plan: "pro",
      pricingState: "failed",
      priceList: null,
    }),
  );

  expect(screen.getByTestId("stats-model-row-glm-5.3")).toBeTruthy();
  expect(
    within(screen.getByTestId("stats-model-row-glm-5.3")).getByText(
      "No reference price",
    ),
  ).toBeTruthy();
  expect(screen.getByTestId("stats-pricing-unavailable")).toBeTruthy();
  expect(screen.queryByTestId("stats-est-cost")).toBeNull();
  expect(screen.queryByTestId("stats-value-ratio")).toBeNull();
});

it("leaves the model mix off a tab whose provider reports no models", async () => {
  installDispatch();

  render(createElement(StatsView, { visible: true }));

  const codexTab = await screen.findByTestId("stats-tab-codex");
  fireEvent.mouseDown(codexTab);
  fireEvent.click(codexTab);

  expect(await screen.findByTestId("stats-account-analytics")).toBeTruthy();
  expect(screen.queryByTestId("stats-model-mix")).toBeNull();
});

it("shows Codex's local model mix with exact costs and cache efficiency", async () => {
  installDispatch();

  render(createElement(StatsView, { visible: true }));

  const codexTab = await screen.findByTestId("stats-tab-codex");
  fireEvent.mouseDown(codexTab);
  fireEvent.click(codexTab);

  expect(await screen.findByTestId("stats-local-logs")).toBeTruthy();

  // Exact tier: the figure arrives priced from the backend's own split, so it
  // is the sum of the per-model costs with no blended assumption in between.
  // The 112.46 + 2.05 total renders as whole dollars above $100.
  const cost = screen.getByTestId("stats-local-cost");
  expect(cost.textContent ?? "").toContain("$115");

  // The cache number is the story: 96% of prompt tokens were cache reads.
  const cache = screen.getByTestId("stats-local-cache");
  expect(cache.textContent ?? "").toContain("96%");

  const gpt55 = screen.getByTestId("stats-local-model-gpt-5.5");
  expect(within(gpt55).getByText("GPT-5.5")).toBeTruthy();
  expect(within(gpt55).getByText("98% of est. cost")).toBeTruthy();
  const luna = screen.getByTestId("stats-local-model-gpt-6-luna");
  expect(within(luna).getByText("2% of est. cost")).toBeTruthy();
  // Token share barely tracks cost share — the two lenses disagree, which is
  // the whole point of showing both.
  expect(within(luna).getByText("51% of tokens · 137.9M")).toBeTruthy();

  // Provenance: which logs, how far back, and that it is not a bill.
  const source = screen.getByTestId("stats-local-source");
  expect(source.textContent ?? "").toContain("168");
  expect(source.textContent ?? "").toContain("2026-09-04");
  expect(source.textContent ?? "").toContain("2026-09-24");
  expect(source.textContent ?? "").toContain("not a bill");
});

it("keeps unpriced local models visible as tokens, never as $0", async () => {
  installDispatch();

  render(createElement(StatsView, { visible: true }));

  const codexTab = await screen.findByTestId("stats-tab-codex");
  fireEvent.mouseDown(codexTab);
  fireEvent.click(codexTab);

  const unpriced = await screen.findByTestId("stats-local-model-gpt-5.5-preview");
  expect(within(unpriced).getByText("No reference price")).toBeTruthy();

  const note = screen.getByTestId("stats-local-unpriced");
  expect(note.textContent ?? "").toContain("1.1M");
});

it("names the logs it could not read instead of implying completeness", () => {
  // Rendered directly: the account-usage atom is session-retained, so a second
  // fixture cannot reach it through a dispatcher.
  render(
    createElement(LocalLogPanel, {
      usage: {
        ...codexAccountUsage().local,
        filesUnreadable: 2,
        filesCompressed: 1,
      },
    }),
  );

  const gaps = screen.getByTestId("stats-local-gaps");
  const text = gaps.textContent ?? "";
  expect(text).toContain("2 unreadable");
  expect(text).toContain("1 compressed");
});

it("leaves the local panel off a tab with no local record", async () => {
  installDispatch();

  render(createElement(StatsView, { visible: true }));

  fireEvent.mouseDown(screen.getByTestId("stats-tab-zai"));
  fireEvent.click(screen.getByTestId("stats-tab-zai"));

  expect(await screen.findByTestId("stats-model-mix")).toBeTruthy();
  expect(screen.queryByTestId("stats-local-logs")).toBeNull();
});
