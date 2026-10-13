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
  ProjectLeaderboard,
  reportsOwnAnalytics,
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
    cacheStats: null,
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
    cacheStats: {
      hitRate: 0.9747,
      promptTokens: 16_000_000_000,
      cachedPromptTokens: 15_594_000_000,
    },
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
          const accountUsage =
            request.provider === "zai"
              ? (overrides?.zaiUsage ?? zaiAccountUsage())
              : (overrides?.codexUsage ?? codexAccountUsage());
          return {
            type: "accountUsage",
            usage:
              request.provider === "codex"
                ? { ...accountUsage, local: null }
                : accountUsage,
          };
        case "readLocalUsage":
          return {
            type: "localUsage",
            usage:
              request.provider === "codex"
                ? codexAccountUsage().local
                : null,
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
  meta: { currency: "USD", updated: "2026-10-11", unit: "per 1M tokens" },
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
 * Holds both reads until the test releases them, reproducing the case where
 * window readings and Codex activity resolve independently. Every release
 * must happen before the test ends: the atoms are session-retained, and a read
 * left pending here would poison later tests.
 */
function installDeferredDispatch(): {
  releaseAccountUsage: (provider: string) => void;
  releaseLocalUsage: (provider: string) => void;
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
            request.provider === "zai"
              ? zaiAccountUsage()
              : { ...codexAccountUsage(), local: null },
        });
      }
      if (request.type === "readLocalUsage") {
        return hold(`local:${request.provider ?? ""}`, {
          type: "localUsage",
          usage:
            request.provider === "codex"
              ? codexAccountUsage().local
              : null,
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
    releaseLocalUsage: (provider) => pending.get(`local:${provider}`)?.(),
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

it("shows the plan reading as soon as quota data arrives before analytics", async () => {
  const release = registerDeferredDispatch();

  render(createElement(StatsView, { visible: true }));

  fireEvent.mouseDown(await screen.findByTestId("stats-tab-codex"));
  fireEvent.click(screen.getByTestId("stats-tab-codex"));

  expect(await screen.findByTestId("stats-account-analytics")).toBeTruthy();
  const skeleton = await screen.findByTestId("stats-analytics-skeleton");

  // The skeleton mirrors the analytics it becomes: a metric-card row and the
  // daily chart block, so the panel never collapses and snaps back.
  const cards = within(skeleton).getByTestId("stats-analytics-skeleton-cards");
  expect(cards.children.length).toBe(4);
  expect(
    within(skeleton).getByTestId("stats-analytics-skeleton-chart"),
  ).toBeTruthy();
  expect(screen.getByTestId("stats-local-logs-skeleton")).toBeTruthy();

  // The old loading line is gone; a placeholder paragraph reserved nothing.
  expect(screen.queryByText("Reading Codex activity…")).toBeNull();

  const reading = await screen.findByTestId("stats-plan-reading");
  expect(within(reading).getByTestId("stats-reading-skeleton")).toBeTruthy();

  release.releaseUsageFor("codex");
  expect(
    await within(reading).findByTestId("stats-plan-window-used-5h"),
  ).toBeTruthy();
  expect(within(reading).queryByTestId("stats-reading-skeleton")).toBeNull();
  expect(
    within(reading).getByTestId("stats-plan-window-used-5h").textContent,
  ).toContain("32% used");

  release.releaseAccountUsage("codex");
  expect(await screen.findByTestId("stats-total-tokens")).toBeTruthy();
  expect(screen.queryByTestId("stats-analytics-skeleton")).toBeNull();
  expect(screen.getByTestId("stats-local-logs-skeleton")).toBeTruthy();
  expect(screen.queryByTestId("stats-local-logs")).toBeNull();
  release.releaseLocalUsage("codex");
  expect(await screen.findByTestId("stats-local-logs")).toBeTruthy();
  expect(screen.queryByTestId("stats-local-logs-skeleton")).toBeNull();
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

it("shows token shares and API-equivalent estimates without cost-share bars", async () => {
  installDispatch();

  render(createElement(StatsView, { visible: true }));
  await openZaiAnalytics();

  // The vendor's ranking leads: GLM-5.3 is sortOrder 1 even though Flash
  // carried more tokens.
  const glm = screen.getByTestId("stats-model-row-glm-5.3");
  expect(within(glm).getByText("GLM-5.3")).toBeTruthy();
  expect(within(glm).getByText("39% of tokens")).toBeTruthy();
  expect(within(glm).getByText(/≈ \$/)).toBeTruthy();
  expect(within(glm).queryByText(/% of est\. cost/)).toBeNull();

  const flash = screen.getByTestId("stats-model-row-glm-5.3-flash");
  expect(within(flash).getByText("61% of tokens")).toBeTruthy();
  expect(within(flash).getByText(/≈ \$/)).toBeTruthy();
  expect(within(flash).queryByText(/% of est\. cost/)).toBeNull();

  // 8.47B at $2.00/M + 13.23B at $0.22/M ≈ $19,855.
  const cost = screen.getByTestId("stats-est-cost");
  expect(cost.textContent ?? "").toMatch(/19[.,]855/);
  // Z.AI publishes its own cache-hit rate, and it is the second card.
  const cache = screen.getByTestId("stats-model-mix-cache");
  expect(cache.textContent ?? "").toContain("97.5%");
  expect(cache.textContent ?? "").toContain("16B prompt tokens were cache reads");
  expect(screen.queryByTestId("stats-value-ratio")).toBeNull();

  const source = screen.getByTestId("stats-model-mix-source");
  expect(source.textContent ?? "").toContain("price list 2026-10-11");
  expect(source.textContent ?? "").toContain("USD per 1M tokens");
  expect(source.textContent ?? "").toContain("80% input");
  expect(source.textContent ?? "").toContain("20% output");
  expect(screen.queryByTestId("stats-unpriced-tokens")).toBeNull();
});

it("reads the prompt-cache rate off the vendor's own number when it publishes one", () => {
  render(
    createElement(ModelMixBlock, {
      kind: "zai",
      models: [
        { id: "glm-5.3", displayName: "GLM-5.3", tokens: 1_000_000, requests: null },
      ],
      windowDays: 30,
      pricingState: "ready",
      priceList: PRICE_LIST,
      cacheStats: {
        hitRate: 0.9747,
        promptTokens: 2_000_000_000,
        cachedPromptTokens: 1_950_000_000,
      },
    }),
  );

  const cache = screen.getByTestId("stats-model-mix-cache");
  // The vendor's rate, to the precision it published it in.
  expect(cache.textContent ?? "").toContain("97.5%");
  expect(cache.textContent ?? "").toContain("2B prompt tokens were cache reads");
  expect(cache.textContent ?? "").toContain("30 days");
});

it("falls back to the token split when the vendor publishes no rate", () => {
  render(
    createElement(ModelMixBlock, {
      kind: "zai",
      models: [
        { id: "glm-5.3", displayName: "GLM-5.3", tokens: 1_000_000, requests: null },
      ],
      windowDays: 30,
      pricingState: "ready",
      priceList: PRICE_LIST,
      cacheStats: {
        hitRate: null,
        promptTokens: 1_000_000_000,
        cachedPromptTokens: 960_000_000,
      },
    }),
  );

  expect(screen.getByTestId("stats-model-mix-cache").textContent ?? "").toContain(
    "96%",
  );
});

it("leaves the cache card off a provider that publishes no split", () => {
  render(
    createElement(ModelMixBlock, {
      kind: "zai",
      models: [
        { id: "glm-5.3", displayName: "GLM-5.3", tokens: 1_000_000, requests: null },
      ],
      windowDays: 30,
      pricingState: "ready",
      priceList: PRICE_LIST,
      cacheStats: null,
    }),
  );

  expect(screen.queryByTestId("stats-model-mix-cache")).toBeNull();
  expect(screen.getByTestId("stats-est-cost")).toBeTruthy();
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
      pricingState: "ready",
      priceList: PRICE_LIST,
      cacheStats: null,
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
      pricingState: "failed",
      priceList: null,
      cacheStats: null,
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

it("shows Codex's local model estimates without cost-share bars", async () => {
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
  expect(within(gpt55).getByText(/≈ \$112/)).toBeTruthy();
  expect(within(gpt55).queryByText(/% of est\. cost/)).toBeNull();
  const luna = screen.getByTestId("stats-local-model-gpt-6-luna");
  expect(within(luna).getByText(/≈ \$2\.05/)).toBeTruthy();
  expect(within(luna).queryByText(/% of est\. cost/)).toBeNull();
  expect(within(luna).getByText("51% of tokens · 137.9M")).toBeTruthy();

  // Provenance: which logs, how far back, and that it is not a bill.
  const source = screen.getByTestId("stats-local-source");
  expect(source.textContent ?? "").toContain("168");
  expect(source.textContent ?? "").toContain("2026-09-04");
  expect(source.textContent ?? "").toContain("2026-09-24");
  expect(source.textContent ?? "").toContain("USD per 1M tokens");
  expect(source.textContent ?? "").toContain("not a bill");
});

it("keeps project API-equivalent amounts without cost-share bars", () => {
  render(
    createElement(LocalLogPanel, {
      usage: {
        ...codexAccountUsage().local,
        projects: [
          {
            name: "agentgauge",
            input: 2_000_000,
            output: 1_000_000,
            responses: 12,
            costUsd: 5.25,
          },
        ],
      },
    }),
  );

  const project = screen.getByTestId("stats-project-row");
  expect(within(project).getByText(/≈ \$5\.25/)).toBeTruthy();
  expect(within(project).queryByText(/% of est\. cost/)).toBeNull();
});

it("presents project usage as ranked cards with clear token and cost details", () => {
  render(
    createElement(ProjectLeaderboard, {
      projects: [
        {
          name: "libryva-monorepo",
          input: 398_540_000,
          output: 0,
          responses: 3_371,
          costUsd: 140,
        },
        {
          name: "No project recorded",
          input: 1_470_000,
          output: 0,
          responses: 10,
          costUsd: null,
        },
      ],
      totalTokens: 662_480_000,
    }),
  );

  const [top, unpriced] = screen.getAllByTestId("stats-project-row");
  expect(
    screen.getByText(/API estimates use reference rates in USD per 1M tokens/),
  ).toBeTruthy();
  expect(top).toBeTruthy();
  expect(unpriced).toBeTruthy();
  expect(within(top!).getByTestId("stats-project-rank").textContent).toBe("01");
  expect(within(top!).getByTestId("stats-project-cost").textContent).toContain(
    "≈ $140",
  );
  expect(
    within(top!).getByTestId("stats-project-details").textContent,
  ).toContain("398.54M tokens · 3,371 responses");
  expect(within(top!).getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "60",
  );
  expect(within(unpriced!).getByTestId("stats-project-rank").textContent).toBe(
    "02",
  );
  expect(within(unpriced!).getByTestId("stats-project-cost").textContent).toContain(
    "Not priced",
  );
  expect(
    within(unpriced!).getByTestId("stats-project-details").textContent,
  ).toContain("1.47M tokens · 10 responses");
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

it("renders the local session metrics and weekly model-share timeline", () => {
  const local = codexAccountUsage().local;
  render(
    createElement(LocalLogPanel, {
      usage: {
        ...local,
        modelDays: [
          {
            day: "2026-09-04",
            id: "gpt-5.5",
            displayName: "GPT-5.5",
            tokens: 120,
            costUsd: null,
          },
          {
            day: "2026-09-24",
            id: "gpt-6-luna",
            displayName: "GPT-6 Luna",
            tokens: 180,
            costUsd: null,
          },
        ],
        sessionDays: [
          { day: "2026-09-04", sessions: 4 },
          { day: "2026-09-24", sessions: 8 },
        ],
        medianTokensPerSession: 1_250_000,
        compactions: 6,
      },
    }),
  );

  expect(screen.getByTestId("stats-local-session-chart")).toBeTruthy();
  expect(screen.getByTestId("stats-local-median-session").textContent).toMatch(
    /1[.,]25M/,
  );
  expect(screen.getByTestId("stats-local-compactions").textContent).toContain("6");
  expect(screen.getByTestId("stats-model-timeline")).toBeTruthy();
  const chartLabel = screen
    .getByTestId("stats-model-timeline-chart")
    .getAttribute("aria-label");
  expect(chartLabel).toContain("GPT-5.5");
  expect(chartLabel).toContain("GPT-6 Luna");
});

/**
 * A coding-plan tab with no provider analytics of its own, answered from
 * OpenCode's local session database: this is the MiniMax/Kimi shape.
 */
function localOnlyUsage() {
  return {
    fetchedAt: 1_791_561_935_000,
    summary: {
      totalTokens: null,
      peakDailyTokens: null,
      longestRunningTurnSec: null,
      currentStreakDays: null,
      longestStreakDays: null,
      totalRequests: null,
    },
    windowDays: null,
    dailyUsageBuckets: [],
    models: [],
    cacheStats: null,
    local: {
      projects: [],
      models: [
        {
          id: "MiniMax-M3",
          displayName: "minimax-M3",
          input: 900_000_000,
          cachedInput: 300_000_000,
          cacheWrite: 0,
          output: 40_000_000,
          reasoning: 10_000_000,
          responses: 900,
          costUsd: 42.5,
        },
      ],
      days: [{ day: "2026-09-24", tokens: 940_000_000 }],
      modelDays: [
        {
          day: "2026-09-24",
          id: "MiniMax-M3",
          displayName: "minimax-M3",
          tokens: 940_000_000,
          costUsd: 42.5,
        },
      ],
      sessionDays: [{ day: "2026-09-24", sessions: 94 }],
      medianTokensPerSession: 9_400_000,
      compactions: null,
      costUsd: 42.5,
      unpricedTokens: 0,
      sessions: 94,
      filesScanned: 1,
      filesUnreadable: 0,
      filesCompressed: 0,
      firstDay: "2026-09-24",
      lastDay: "2026-10-12",
    },
  };
}

it("answers a coding-plan tab from OpenCode's local sessions", () => {
  render(
    createElement(LocalLogPanel, {
      usage: localOnlyUsage().local,
      source: "OpenCode",
    }),
  );

  // The panel names its own source: these numbers came from OpenCode's
  // database, not from the plan vendor.
  const source = screen.getByTestId("stats-local-source");
  expect(source.textContent ?? "").toContain("OpenCode");
  expect(source.textContent ?? "").toContain("94");
  expect(source.textContent ?? "").toContain("2026-09-24");
  expect(source.textContent ?? "").toContain("2026-10-12");

  const cost = screen.getByTestId("stats-local-cost");
  expect(cost.textContent ?? "").toMatch(/42[.,]50/);
  const cache = screen.getByTestId("stats-local-cache");
  expect(cache.textContent ?? "").toContain("33%");
  expect(screen.getByTestId("stats-local-session-chart")).toBeTruthy();
  expect(screen.getByTestId("stats-local-median-session").textContent).toContain(
    "9.4M",
  );
  expect(screen.getByTestId("stats-local-compactions").textContent).toContain(
    "Not reported",
  );
  expect(
    screen.getByTestId("stats-model-timeline-chart").getAttribute("aria-label"),
  ).toContain("minimax-M3");
});

it("shows a local reading on a coding-plan tab that reports nothing itself", async () => {
  installDispatch();

  render(createElement(StatsView, { visible: true }));

  const tab = await screen.findByTestId("stats-tab-alibaba-coding-plan");
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);

  // Alibaba has no integration, so its tab shows only the window reading and
  // no local panel — the reading is absent, not zero.
  expect(await screen.findByTestId("stats-plan-unreadable")).toBeTruthy();
  expect(screen.queryByTestId("stats-local-logs")).toBeNull();
});

it("does not double up the model mix when the provider reports its own", async () => {
  installDispatch();

  render(createElement(StatsView, { visible: true }));

  const tab = await screen.findByTestId("stats-tab-zai");
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);

  // Z.AI's monitor API already answers with a model mix; the OpenCode local
  // record is a different lens, not a second copy of the same panel.
  expect(await screen.findByTestId("stats-model-mix")).toBeTruthy();
  expect(screen.queryByTestId("stats-local-logs")).toBeNull();
});

it("says a plan publishes no analytics before showing its local reading", () => {
  // MiniMax/Kimi shape: no provider totals at all, only the local ledger.
  expect(reportsOwnAnalytics(localOnlyUsage())).toBe(false);
  expect(reportsOwnAnalytics(zaiAccountUsage())).toBe(true);
  expect(reportsOwnAnalytics(codexAccountUsage())).toBe(true);
});


it("lists every readable plan on the overview", async () => {
  installDispatch();

  render(createElement(StatsView, { visible: true }));

  const tab = await screen.findByTestId("stats-tab-all");
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);

  const overview = await screen.findByTestId("stats-all-plans");
  expect(overview).toBeTruthy();

  // Every readable plan is listed, each with its own numbers.
  expect(screen.getByTestId("stats-plan-row-codex")).toBeTruthy();
  expect(screen.getByTestId("stats-plan-row-zai")).toBeTruthy();

  // The spans differ, so nothing is summed into a single headline.
  expect(screen.queryByTestId("stats-all-plans-total")).toBeNull();
  const note = screen.getByTestId("stats-all-plans-not-summed");
  expect(note.textContent ?? "").toContain("window");
});
