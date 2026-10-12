import { expect, browser, $, $$ } from "@wdio/globals";

import {
  dashboardLive,
  dashboardWithLocalCodingPlan,
  dashboardWithPlans,
  dashboardWithSlowStats,
  dashboardWithZaiAnalytics,
  dashboardWithZaiWeek,
  dispatchCalls,
  clickDisplayed,
  expectDisplayed,
  gotoView,
  clearSeededStores,
} from "../fixtures.js";

/**
 * The Stats view: local analytics that is simply on, one tab per connected
 * plan, and the opt-out that stays a preference rather than a permission.
 *
 * Runs in the single ordered group configured in `wdio.conf.ts`; the harness
 * rules that make that work live in `../fixtures.ts`. The persisted stores are
 * restored at *file* scope, which is the only place mocha runs an `after`
 * after every `describe` here has finished.
 *
 * Tab switches use `clickDisplayed` (the driver's native click): the
 * fixtures' trap notes that page-level DOM clicks do not reliably reach React
 * for Radix tabs, and the usage-tabs specs prove the native path.
 */
after(() => {
  clearSeededStores();
});

describe("stats", () => {
  it("renders Codex analytics without asking, because analytics defaults on", async () => {
    await dashboardLive();
    await gotoView("stats");

    // The view lands on the overview; the Codex tab is one click away and
    // still reads by default once open.
    await clickDisplayed('[data-testid="stats-tab-codex"]');
    await expectDisplayed('[data-testid="stats-account-analytics"]');
    expect(
      (await $$('[data-testid="stats-analytics-consent"]')).length,
    ).toBe(0);
    expect(
      await $('[data-testid="stats-analytics-off"]').isExisting(),
    ).toBe(false);

    const values = await browser.execute(() => ({
      total: document.querySelector('[data-testid="stats-total-tokens"]')
        ?.textContent,
      historyReads:
        (
          window as unknown as { __ismMockCalls__?: Array<{ type?: string }> }
        ).__ismMockCalls__?.filter(
          (request) => request.type === "readAccountUsage",
        ).length ?? 0,
    }));
    expect(values.historyReads).toBeGreaterThan(0);
    // The token count opens compact; pressing — not hovering — pins the
    // exact number. Hover itself (a chart-primary tint, never a number
    // switch) is pinned by the unit test: WebKit applies :hover only from
    // real mouse-moves, which this driver's synthetic pointer cannot
    // produce, so the tint is verified manually in the running app.
    expect(/1[.,]23M/.test(values.total ?? "")).toBe(true);
    await clickDisplayed('[data-testid="stats-total-tokens"]');
    const exact = await browser.execute(
      () =>
        document.querySelector('[data-testid="stats-total-tokens"]')
          ?.textContent,
    );
    expect(exact?.replace(/\D/g, "")).toBe("1234567");
    await expectDisplayed('[data-testid="stats-daily-chart"]');
    await expectDisplayed('[data-testid="stats-current-streak"]');
    await expectDisplayed('[data-testid="stats-analytics-source"]');

    // The window reading rides below the analytics, exactly like the other
    // token-history tabs: the chart answers what the tokens did, the windows
    // answer how full the plan is.
    await expectDisplayed('[data-testid="stats-plan-reading"]');
    const reading = await browser.execute(() => ({
      plan: document.querySelector('[data-testid="stats-plan-name"]')
        ?.textContent,
      fiveHour: document.querySelector(
        '[data-testid="stats-plan-window-used-5h"]',
      )?.textContent,
      source: document.querySelector('[data-testid="stats-plan-source"]')
        ?.textContent,
    }));
    expect(reading.plan).toBeTruthy();
    expect(reading.fiveHour).toContain("used");
    expect(reading.source).toContain("app-server");
  });

  it("gives every connected plan a tab and shows its stats there", async () => {
    await dashboardWithPlans();
    await gotoView("stats");

    await expectDisplayed('[data-testid="stats-tab-codex"]');
    await expectDisplayed('[data-testid="stats-tab-zai"]');
    await expectDisplayed('[data-testid="stats-tab-alibaba-coding-plan"]');

    await clickDisplayed('[data-testid="stats-tab-zai"]');
    await expectDisplayed('[data-testid="stats-plan-reading"]');
    const zai = await browser.execute(() => ({
      plan: document.querySelector('[data-testid="stats-plan-name"]')
        ?.textContent,
      fiveHour: document.querySelector(
        '[data-testid="stats-plan-window-used-5h"]',
      )?.textContent,
    }));
    expect(zai.plan).toBe("Pro");
    expect(zai.fiveHour).toContain("16% used");
    await expectDisplayed('[data-testid="stats-plan-source"]');

    await clickDisplayed('[data-testid="stats-tab-alibaba-coding-plan"]');
    await expectDisplayed('[data-testid="stats-plan-unreadable"]');

    // Leave the selection on Codex: the tab atom outlives this spec's boot in
    // the shared document, and a later boot mounting this tab's body would
    // read through the real backend before its mock is installed.
    await clickDisplayed('[data-testid="stats-tab-codex"]');
  });

  it("shows Z.AI token analytics like Codex's, labelled with its window", async () => {
    await dashboardWithZaiAnalytics();
    await gotoView("stats");

    await clickDisplayed('[data-testid="stats-tab-zai"]');
    await expectDisplayed('[data-testid="stats-plan-analytics"]');
    await expectDisplayed('[data-testid="stats-daily-chart"]');

    // Hovering a bar raises the tooltip: exact number first, the compact form
    // in brackets beside it, on a properly spaced row.
    let tooltip: { text: string; gap: string } | null = null;
    const readTooltip = () =>
      browser.execute(() => {
        const row = document.querySelector(
          ".recharts-tooltip-wrapper .gap-2",
        );
        if (!row) return null;
        return {
          text: row.textContent ?? "",
          gap: getComputedStyle(row).columnGap,
        };
      });
    for (const fraction of [0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85]) {
      await browser.execute((fx) => {
        const chart = document.querySelector<HTMLElement>(
          '[data-testid="stats-daily-chart"]',
        );
        if (!chart) return;
        // Recharts binds its mousemove handler on the wrapper *inside* this
        // container, so the event must be dispatched on a descendant — the
        // chart surface — and bubble up through it.
        const surface = chart.querySelector("svg") ?? chart;
        const rect = surface.getBoundingClientRect();
        surface.dispatchEvent(
          new MouseEvent("mousemove", {
            bubbles: true,
            clientX: rect.x + rect.width * (fx as number),
            clientY: rect.y + rect.height * 0.85,
          }),
        );
      }, fraction);
      await browser.pause(200);
      tooltip = await readTooltip();
      if (tooltip) break;
    }
    if (!tooltip) {
      const rect = await browser.execute(() => {
        const box = document
          .querySelector('[data-testid="stats-daily-chart"]')
          ?.getBoundingClientRect();
        return box
          ? { x: box.x, y: box.y, width: box.width, height: box.height }
          : null;
      });
      if (rect) {
        for (const fraction of [0.3, 0.45, 0.6, 0.75]) {
          await browser.performActions([
            {
              type: "pointer",
              id: "stats-tooltip-pointer",
              parameters: { pointerType: "mouse" },
              actions: [
                {
                  type: "pointerMove",
                  duration: 0,
                  x: Math.round(rect.x + rect.width * fraction),
                  y: Math.round(rect.y + rect.height * 0.85),
                },
              ],
            },
          ]);
          await browser.pause(250);
          tooltip = await readTooltip();
          if (tooltip) break;
        }
        await browser.releaseActions();
      }
    }
    expect(tooltip).not.toBeNull();
    expect(/\(\d+[.,]\d+[MB]\)/.test(tooltip?.text ?? "")).toBe(true);
    expect(Number.parseFloat(tooltip?.gap ?? "0")).toBeGreaterThan(4);

    const analytics = await browser.execute(() => ({
      tokens: document.querySelector('[data-testid="stats-total-tokens"]')
        ?.textContent,
      calls: document.querySelector('[data-testid="stats-total-requests"]')
        ?.textContent,
      coverage: document.querySelector(
        '[data-testid="stats-activity-coverage"]',
      )?.textContent,
      reading: Array.from(
        document.querySelectorAll('[data-testid="stats-plan-reading"]'),
      ).some((el) => (el as HTMLElement).offsetParent !== null),
    }));
    expect(analytics.tokens ? /21[.,]7B/.test(analytics.tokens) : false).toBe(
      true,
    );
    expect(analytics.calls?.replace(/\D/g, "")).toBe("10419");
    // Clicking the token count pins the exact number, this card only.
    await clickDisplayed('[data-testid="stats-total-tokens"]');
    const pinned = await browser.execute(
      () =>
        document.querySelector('[data-testid="stats-total-tokens"]')
          ?.textContent,
    );
    expect(pinned?.replace(/\D/g, "")).toBe("21700000000");
    expect(analytics.coverage).toContain("2026-10-08");
    // The window reading stays on the tab beside the analytics.
    expect(analytics.reading).toBe(true);
    await expectDisplayed('[data-testid="stats-plan-analytics-source"]');

    await clickDisplayed('[data-testid="stats-tab-codex"]');
  });

  it("stands in with shaped skeletons while a plan's first stats load", async () => {
    await dashboardWithSlowStats();
    await gotoView("stats");

    await clickDisplayed('[data-testid="stats-tab-zai"]');

    // The analytics skeleton reserves everything the reading becomes: the
    // metric-card row and the chart at its full height, so the panel never
    // collapses and snaps back when the reading lands.
    await expectDisplayed(
      '[data-testid="stats-plan-analytics"] [data-testid="stats-analytics-skeleton"]',
    );
    await expectDisplayed(
      '[data-testid="stats-plan-analytics"] [data-testid="stats-analytics-skeleton-cards"]',
    );
    await expectDisplayed(
      '[data-testid="stats-plan-analytics"] [data-testid="stats-analytics-skeleton-chart"]',
    );

    // The reading below reserves its own shape: pill, cards, source line.
    await expectDisplayed('[data-testid="stats-reading-skeleton"]');
    await expectDisplayed('[data-testid="stats-reading-skeleton-pill"]');
    await expectDisplayed('[data-testid="stats-reading-skeleton-cards"]');
    await expectDisplayed('[data-testid="stats-reading-skeleton-source"]');

    await expect($('[data-testid="stats-total-tokens"]')).toHaveText(
      /21[.,]7B/,
    );
    await expectDisplayed('[data-testid="stats-plan-window-used-5h"]');
    expect(await $$('[data-testid="stats-analytics-skeleton"]')).toHaveLength(0);
    expect(await $$('[data-testid="stats-reading-skeleton"]')).toHaveLength(0);
  });

  it("shows a revisited plan from its retained reading, skeleton-free", async () => {
    await dashboardWithZaiAnalytics();
    await gotoView("stats");

    await clickDisplayed('[data-testid="stats-tab-zai"]');
    await expect($('[data-testid="stats-total-tokens"]')).toHaveText(
      /21[.,]7B/,
    );

    await clickDisplayed('[data-testid="stats-tab-codex"]');
    await expectDisplayed('[data-testid="stats-total-tokens"]');

    await clickDisplayed('[data-testid="stats-tab-zai"]');
    await expect($('[data-testid="stats-total-tokens"]')).toHaveText(
      /21[.,]7B/,
    );
    expect(await $$('[data-testid="stats-analytics-skeleton"]')).toHaveLength(0);
    expect(await $$('[data-testid="stats-reading-skeleton"]')).toHaveLength(0);
  });

  it("offers no analytics off switch anywhere on the screen", async () => {
    await dashboardLive();
    await gotoView("stats");

    // Analytics is the product: it reads by default and there is nothing to
    // turn off — no button, no disabled state, no gate.
    await clickDisplayed('[data-testid="stats-tab-codex"]');
    await expectDisplayed('[data-testid="stats-account-analytics"]');
    expect(
      await $('[data-testid="stats-disable-analytics"]').isExisting(),
    ).toBe(false);
    expect(
      await $('[data-testid="stats-enable-analytics"]').isExisting(),
    ).toBe(false);
    expect(
      await $('[data-testid="stats-analytics-off"]').isExisting(),
    ).toBe(false);
  });

  it("shows the model mix with both shares and the plan value", async () => {
    await dashboardWithZaiAnalytics();
    await gotoView("stats");

    await clickDisplayed('[data-testid="stats-tab-zai"]');
    await expectDisplayed('[data-testid="stats-model-mix"]');
    await expectDisplayed('[data-testid="stats-model-row-glm-5.3"]');
    await expectDisplayed('[data-testid="stats-model-row-glm-5.3-flash"]');
    await expectDisplayed('[data-testid="stats-est-cost"]');
    await expectDisplayed('[data-testid="stats-value-ratio"]');

    // The two lenses read as text, locale-free: the vendor's primary model
    // leads with 39% of tokens but 85% of the estimated dollars.
    const shares = await browser.execute(() => {
      const read = (id: string) =>
        document
          .querySelector(`[data-testid="${id}"]`)
          ?.textContent?.replace(/\s+/g, " ") ?? "";
      return {
        glm: read("stats-model-row-glm-5.3"),
        flash: read("stats-model-row-glm-5.3-flash"),
        ratio: read("stats-value-ratio"),
        source: read("stats-model-mix-source"),
      };
    });
    expect(shares.glm).toContain("39% of tokens");
    expect(shares.glm).toContain("85% of est. cost");
    expect(shares.flash).toContain("61% of tokens");
    expect(shares.flash).toContain("15% of est. cost");
    expect(shares.ratio).toContain("248");
    // The provenance travels with the estimate: price-list date, the
    // input-share assumption, and the not-a-bill disclaimer.
    expect(shares.source).toContain("price list 2026-10-11");
    expect(shares.source).toContain("80% input");
    expect(shares.source).toContain("not a bill");
  });
  it("shows Codex's local model mix with exact cost and cache efficiency", async () => {
    await dashboardLive();
    await gotoView("stats");

    await clickDisplayed('[data-testid="stats-tab-codex"]');
    await expectDisplayed('[data-testid="stats-local-logs"]');
    await expectDisplayed('[data-testid="stats-local-model-gpt-5.5"]');
    await expectDisplayed('[data-testid="stats-local-model-gpt-6-luna"]');

    const reading = await browser.execute(() => {
      const read = (id: string) =>
        document
          .querySelector(`[data-testid="${id}"]`)
          ?.textContent?.replace(/\s+/g, " ") ?? "";
      return {
        cost: read("stats-local-cost"),
        cache: read("stats-local-cache"),
        source: read("stats-local-source"),
        gpt55: read("stats-local-model-gpt-5.5"),
        luna: read("stats-local-model-gpt-6-luna"),
        unpriced: read("stats-local-model-gpt-5.5-preview"),
        note: read("stats-local-unpriced"),
      };
    });

    // The exact figure is the sum of the per-model costs (112.46 + 2.05).
    expect(reading.cost).toContain("$115");
    // The cache share is the reason that figure stays small.
    expect(reading.cache).toContain("96%");
    // Token share and cost share disagree, which is why both lenses render:
    // Luna carries about half the tokens for 2% of the dollars.
    expect(reading.gpt55).toContain("98% of est. cost");
    expect(reading.luna).toContain("2% of est. cost");
    expect(reading.luna).toContain("51% of tokens");
    // A model the price list cannot cover stays a token count, never $0.
    expect(reading.unpriced).toContain("No reference price");
    expect(reading.note).toContain("1.1M");
    // Provenance: the logs, the span they cover, and the not-a-bill claim.
    expect(reading.source).toContain("168");
    expect(reading.source).toContain("2026-09-04");
    expect(reading.source).toContain("2026-09-24");
    expect(reading.source).toContain("not a bill");
  });
  it("answers a coding-plan tab from OpenCode's local sessions", async () => {
    await dashboardWithLocalCodingPlan();
    await gotoView("stats");

    await clickDisplayed('[data-testid="stats-tab-minimax"]');
    // The vendor publishes no analytics, and the screen says so before showing
    // the local reading rather than a panel of "not reported".
    await expectDisplayed('[data-testid="stats-plan-no-provider-analytics"]');
    await expectDisplayed('[data-testid="stats-local-logs"]');
    await expectDisplayed('[data-testid="stats-local-model-MiniMax-M3"]');

    const reading = await browser.execute(() => {
      const read = (id: string) =>
        document
          .querySelector(`[data-testid="${id}"]`)
          ?.textContent?.replace(/\s+/g, " ") ?? "";
      return {
        cost: read("stats-local-cost"),
        cache: read("stats-local-cache"),
        source: read("stats-local-source"),
        row: read("stats-local-model-MiniMax-M3"),
      };
    });

    expect(reading.cost).toMatch(/42[.,]50/);
    expect(reading.cache).toContain("33%");
    expect(reading.row).toMatch(/42[.,]50/);
    expect(reading.row).toContain("100% of est. cost");
    // The provenance names OpenCode as the source, not the plan vendor: these
    // numbers came from OpenCode's database on this machine.
    expect(reading.source).toContain("OpenCode");
    expect(reading.source).toContain("94");
    expect(reading.source).toContain("2026-09-24");
    expect(reading.source).toContain("2026-10-12");
    expect(reading.source).toContain("not a bill");
  });
  it("opens on an all-plans overview that sums nothing", async () => {
    await dashboardWithZaiAnalytics();
    await gotoView("stats");

    // The overview is the landing tab, and it lists each plan on its own row.
    await expectDisplayed('[data-testid="stats-all-plans"]');
    await expectDisplayed('[data-testid="stats-plan-row-codex"]');
    await expectDisplayed('[data-testid="stats-plan-row-zai"]');

    const overview = await browser.execute(() => {
      const read = (id: string) =>
        document
          .querySelector(`[data-testid="${id}"]`)
          ?.textContent?.replace(/\s+/g, " ") ?? "";
      return {
        codexSource: read("stats-plan-row-codex-source"),
        codexCost: read("stats-plan-row-codex-cost"),
        zaiSource: read("stats-plan-row-zai-source"),
        note: read("stats-all-plans-not-summed"),
        totalExists:
          document.querySelector('[data-testid="stats-all-plans-total"]') !==
          null,
      };
    });

    // Each row names its own span, and neither is folded into a total the
    // spans could not support.
    expect(overview.codexSource).toContain("local sessions");
    expect(overview.codexCost).toContain("$");
    expect(overview.zaiSource).toContain("30 days");
    expect(overview.totalExists).toBe(false);
    expect(overview.note).toContain("summed");
  });
  it("draws the activity heatmap over the span the logs cover", async () => {
    await dashboardLive();
    await gotoView("stats");

    await clickDisplayed('[data-testid="stats-tab-codex"]');
    await expectDisplayed('[data-testid="stats-activity-heatmap"]');

    const heatmap = await browser.execute(() => {
      const root = document.querySelector('[data-testid="stats-activity-heatmap"]');
      const cells = Array.from(
        root?.querySelectorAll("[data-testid^='stats-activity-cell-']") ?? [],
      ).map((cell) => ({
        id: cell.getAttribute("data-testid") ?? "",
        state: cell.getAttribute("data-state") ?? "",
      }));
      return {
        label:
          root
            ?.querySelector('[data-testid="stats-activity-busiest"]')
            ?.textContent?.replace(/\s+/g, " ") ?? "",
        cells,
      };
    });

    // The grid covers the log span, labels it, and distinguishes a day with
    // no record from a day that recorded nothing.
    expect(heatmap.label).toContain("2026-09-04");
    expect(heatmap.label).toContain("2026-09-24");
    expect(heatmap.cells.length).toBe(21);
    const gap = heatmap.cells.find((cell) =>
      cell.id.endsWith("2026-09-06"),
    );
    expect(gap?.state).toBe("no-record");
    const recorded = heatmap.cells.find((cell) =>
      cell.id.endsWith("2026-09-04"),
    );
    expect(recorded?.state).toBe("peak");
  });
  it("draws the heatmap on a provider tab from its own daily series", async () => {
    await dashboardWithZaiWeek();
    await gotoView("stats");

    await clickDisplayed('[data-testid="stats-tab-zai"]');
    // The heatmap is not a local-logs feature: a provider that reports its
    // own daily series gets the same activity view, or the tab a Z.AI user
    // lives on has no "when" at all.
    await expectDisplayed('[data-testid="stats-activity-heatmap"]');

    const reading = await browser.execute(() => {
      const read = (id: string) =>
        document
          .querySelector(`[data-testid="${id}"]`)
          ?.textContent?.replace(/\s+/g, " ") ?? "";
      return {
        source: read("stats-activity-source"),
        busiest: read("stats-activity-busiest"),
        cellExists:
          document.querySelector('[data-testid="stats-activity-cell-2026-10-08"]') !==
          null,
        heatmaps: document.querySelectorAll("[data-testid='stats-activity-heatmap']")
          .length,
      };
    });

    expect(reading.cellExists).toBe(true);
    expect(reading.source).toContain("Z.AI");
    expect(reading.source).toContain("30 days");
    expect(reading.busiest).toContain("2026-10-07");
    expect(reading.busiest).toContain("2026-10-10");
    // Exactly one activity view per tab.
    expect(reading.heatmaps).toBe(1);
  });
});
