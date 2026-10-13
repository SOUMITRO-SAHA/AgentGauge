import { describe, expect, it } from "vitest";

import {
  calendarDateRange,
  cumulativeCostSeries,
  costThresholdDay,
  providerDailyCostValues,
  rollingSevenDayAverage,
  weeklyModelTimeline,
} from "~/lib/stats-analytics";
import type * as Ipc from "~/lib/ipc";
import type { PriceList } from "~/lib/pricing";

describe("calendarDateRange", () => {
  it("keeps missing dates as calendar slots without assigning them usage", () => {
    expect(
      calendarDateRange(["2026-10-04", "2026-10-01", "2026-10-04"]),
    ).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
  });

  it("preserves invalid date labels and handles empty input", () => {
    expect(calendarDateRange([])).toEqual([]);
    expect(calendarDateRange(["unknown-day"])).toEqual(["unknown-day"]);
  });
});

describe("rollingSevenDayAverage", () => {
  it("requires seven consecutive reported days", () => {
    const result = rollingSevenDayAverage([
      { day: "2026-10-01", tokens: 10 },
      { day: "2026-10-02", tokens: 20 },
      { day: "2026-10-03", tokens: 30 },
      { day: "2026-10-04", tokens: 40 },
      { day: "2026-10-05", tokens: 50 },
      { day: "2026-10-06", tokens: 60 },
      { day: "2026-10-07", tokens: 70 },
    ]);

    expect(result.map((day) => day.rollingAverage)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      40,
    ]);
  });

  it("leaves a missing date or null bucket unknown instead of treating it as zero", () => {
    const result = rollingSevenDayAverage([
      { day: "2026-10-01", tokens: 10 },
      { day: "2026-10-02", tokens: 20 },
      { day: "2026-10-03", tokens: 30 },
      { day: "2026-10-04", tokens: 40 },
      { day: "2026-10-05", tokens: 50 },
      { day: "2026-10-06", tokens: 60 },
      { day: "2026-10-08", tokens: 80 },
      { day: "2026-10-09", tokens: null },
    ]);

    expect(result[result.length - 2]?.rollingAverage).toBeNull();
    expect(result[result.length - 1]?.rollingAverage).toBeNull();
  });
});

describe("cumulativeCostSeries", () => {
  it("stops cumulative totals at the first day whose cost is incomplete", () => {
    const result = cumulativeCostSeries([
      { day: "2026-10-01", costUsd: 1 },
      { day: "2026-10-02", costUsd: 2 },
      { day: "2026-10-03", costUsd: null },
      { day: "2026-10-04", costUsd: 4 },
    ]);

    expect(result.map((day) => day.cumulativeUsd)).toEqual([1, 3, null, null]);
    expect(result[2]?.incompleteFrom).toBe("2026-10-03");
    expect(costThresholdDay(result, 2.5)).toBe("2026-10-02");
    expect(costThresholdDay(result, null)).toBeNull();
  });

  it("does not bridge a date with no reported daily cost", () => {
    const result = cumulativeCostSeries([
      { day: "2026-10-01", costUsd: 1 },
      { day: "2026-10-03", costUsd: 2 },
    ]);

    expect(result.map((day) => day.cumulativeUsd)).toEqual([1, null]);
    expect(result[1]?.incompleteFrom).toBe("2026-10-02");
  });
});

describe("model-day coverage and costs", () => {
  const priceList: PriceList = {
    meta: {
      updated: "2026-10-11",
      currency: "USD",
      unit: "per 1M tokens",
    },
    providers: {
      example: {
        models: {
          known: { cost_per_million: { input: 1, output: 2 } },
        },
      },
    },
  };

  it("prices provider days only when model rows reconcile to the reported total", () => {
    const modelDays: Ipc.ModelDayUsage[] = [
      {
        day: "2026-10-01",
        modelId: "known",
        displayName: "Known",
        tokens: 1_000_000,
      },
      {
        day: "2026-10-02",
        modelId: "missing",
        displayName: "Missing",
        tokens: 1_000_000,
      },
    ];
    const totals = [
      { day: "2026-10-01", tokens: 1_000_000 },
      { day: "2026-10-02", tokens: 1_000_000 },
      { day: "2026-10-03", tokens: 20 },
    ];

    expect(
      providerDailyCostValues(modelDays, totals, priceList, "example"),
    ).toEqual([
      { day: "2026-10-01", costUsd: 1.2 },
      { day: "2026-10-02", costUsd: null },
      { day: "2026-10-03", costUsd: null },
    ]);
  });
});

describe("weeklyModelTimeline", () => {
  it("groups models by UTC Monday and keeps lower-volume models in an Other series", () => {
    const timeline = weeklyModelTimeline(
      [
        { day: "2026-10-05", modelId: "alpha", displayName: "Alpha", tokens: 30 },
        { day: "2026-10-06", modelId: "beta", displayName: "Beta", tokens: 70 },
        { day: "2026-10-12", modelId: "beta", displayName: "Beta", tokens: 60 },
        { day: "2026-10-12", modelId: "gamma", displayName: "Gamma", tokens: 40 },
      ],
      1,
    );

    expect(timeline.series.map((item) => item.displayName)).toEqual([
      "Beta",
      "Other models",
    ]);
    expect(timeline.rows).toEqual([
      {
        weekStart: "2026-10-05",
        model0: 70,
        other: 30,
      },
      {
        weekStart: "2026-10-12",
        model0: 60,
        other: 40,
      },
    ]);
  });
});
