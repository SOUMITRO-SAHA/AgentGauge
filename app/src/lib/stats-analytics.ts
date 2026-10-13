import { estimateModelCosts } from "~/lib/pricing";
import type * as Ipc from "~/lib/ipc";
import type { PriceList } from "~/lib/pricing";

export type DailyTokenValue = {
  readonly day: string;
  readonly tokens: number | null;
};

export type DailyTokenAverage = DailyTokenValue & {
  readonly rollingAverage: number | null;
};

export function rollingSevenDayAverage(
  days: readonly DailyTokenValue[],
): DailyTokenAverage[] {
  const ordered = [...days].sort((left, right) =>
    left.day.localeCompare(right.day),
  );
  const values = new Map(ordered.map((day) => [day.day, day.tokens]));

  return ordered.map((day) => {
    const end = utcDay(day.day);
    if (end === null) return { ...day, rollingAverage: null };
    let total = 0;

    for (let offset = 0; offset < 7; offset += 1) {
      const value = values.get(isoDay(end - offset * DAY_MS));
      if (value === undefined || value === null) {
        return { ...day, rollingAverage: null };
      }
      total += value;
    }

    return { ...day, rollingAverage: total / 7 };
  });
}

export type DailyCostValue = {
  readonly day: string;
  readonly costUsd: number | null;
};

export type CumulativeCostValue = DailyCostValue & {
  readonly cumulativeUsd: number | null;
  readonly incompleteFrom: string | null;
};

export function cumulativeCostSeries(
  days: readonly DailyCostValue[],
): CumulativeCostValue[] {
  let cumulativeUsd = 0;
  let incompleteFrom: string | null = null;
  let previousDay: number | null = null;

  return [...days]
    .sort((left, right) => left.day.localeCompare(right.day))
    .map((day) => {
      const timestamp = utcDay(day.day);
      const missingDayStart =
        previousDay !== null &&
        timestamp !== null &&
        timestamp - previousDay > DAY_MS;
      if (missingDayStart && previousDay !== null) {
        incompleteFrom = isoDay(previousDay + DAY_MS);
      }
      previousDay = timestamp;
      if (
        incompleteFrom !== null ||
        timestamp === null ||
        day.costUsd === null ||
        !Number.isFinite(day.costUsd) ||
        day.costUsd < 0
      ) {
        incompleteFrom ??= day.day;
        return { ...day, cumulativeUsd: null, incompleteFrom };
      }

      cumulativeUsd += day.costUsd;
      return { ...day, cumulativeUsd, incompleteFrom: null };
    });
}

export function costThresholdDay(
  series: readonly CumulativeCostValue[],
  thresholdUsd: number | null,
): string | null {
  if (thresholdUsd === null || thresholdUsd <= 0) return null;
  return (
    series.find(
      (day) => day.cumulativeUsd !== null && day.cumulativeUsd >= thresholdUsd,
    )?.day ?? null
  );
}

export type ModelDayValue = {
  readonly day: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly tokens: number;
};

export type ModelTimelineSeries = {
  readonly key: string;
  readonly modelId: string | null;
  readonly displayName: string;
};

export type ModelTimelineRow = {
  readonly weekStart: string;
  readonly [key: string]: string | number;
};

export type WeeklyModelTimeline = {
  readonly series: readonly ModelTimelineSeries[];
  readonly rows: readonly ModelTimelineRow[];
};

export function weeklyModelTimeline(
  modelDays: readonly ModelDayValue[],
  maxModels = 4,
): WeeklyModelTimeline {
  const validDays = modelDays.filter(
    (item) =>
      utcDay(item.day) !== null &&
      Number.isFinite(item.tokens) &&
      item.tokens >= 0,
  );
  const totalsByModel = new Map<string, number>();
  const namesByModel = new Map<string, string>();
  for (const item of validDays) {
    totalsByModel.set(
      item.modelId,
      (totalsByModel.get(item.modelId) ?? 0) + item.tokens,
    );
    namesByModel.set(item.modelId, item.displayName);
  }
  const ranked = [...totalsByModel]
    .sort(([leftId, leftTotal], [rightId, rightTotal]) =>
      rightTotal - leftTotal || leftId.localeCompare(rightId),
    );
  const top = ranked.slice(0, Math.max(1, maxModels));
  const otherIds = new Set(ranked.slice(top.length).map(([id]) => id));
  const series: ModelTimelineSeries[] = top.map(([modelId], index) => ({
    key: `model${index}`,
    modelId,
    displayName: namesByModel.get(modelId) ?? modelId,
  }));
  if (otherIds.size > 0) {
    series.push({ key: "other", modelId: null, displayName: "Other models" });
  }

  const weekly = new Map<string, Map<string, number>>();
  for (const item of validDays) {
    const start = isoDay(weekStart(utcDay(item.day) as number));
    let values = weekly.get(start);
    if (values === undefined) {
      values = new Map();
      weekly.set(start, values);
    }
    const selected = series.find((candidate) => candidate.modelId === item.modelId);
    const key = selected?.key ?? (otherIds.has(item.modelId) ? "other" : null);
    if (key !== null) values.set(key, (values.get(key) ?? 0) + item.tokens);
  }

  const rows = [...weekly]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([weekStart, values]) => {
      const total = [...values.values()].reduce((sum, tokens) => sum + tokens, 0);
      const row: Record<string, string | number> = { weekStart };
      for (const item of series) {
        row[item.key] = total > 0 ? ((values.get(item.key) ?? 0) / total) * 100 : 0;
      }
      return row as ModelTimelineRow;
    });

  return { series, rows };
}

export function providerDailyCostValues(
  modelDays: readonly Ipc.ModelDayUsage[],
  dailyTotals: readonly DailyTokenValue[],
  priceList: PriceList,
  providerId: string,
): DailyCostValue[] {
  const byDay = groupByDay(modelDays);
  return [...dailyTotals]
    .sort((left, right) => left.day.localeCompare(right.day))
    .map((day) => {
      if (day.tokens === null) return { day: day.day, costUsd: null };
      const models = byDay.get(day.day) ?? [];
      const modelTokens = models.reduce((sum, model) => sum + model.tokens, 0);
      if (modelTokens !== day.tokens) {
        return { day: day.day, costUsd: null };
      }
      const estimate = estimateModelCosts(
        models.map((model) => ({
          id: model.modelId,
          displayName: model.displayName,
          tokens: model.tokens,
          requests: null,
        })),
        priceList,
        providerId,
      );
      return {
        day: day.day,
        costUsd:
          estimate.unpricedTokens === 0 ? estimate.estimatedTotalUsd : null,
      };
    });
}

function groupByDay<T extends { readonly day: string }>(
  items: readonly T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const day = grouped.get(item.day) ?? [];
    day.push(item);
    grouped.set(item.day, day);
  }
  return grouped;
}

const DAY_MS = 86_400_000;

export function calendarDateRange(days: readonly string[]): string[] {
  const labels = [...new Set(days)];
  const valid = labels
    .map((day) => ({ day, timestamp: utcDay(day) }))
    .filter(
      (entry): entry is { day: string; timestamp: number } =>
        entry.timestamp !== null,
    );
  if (valid.length === 0) {
    return labels.sort((left, right) => left.localeCompare(right));
  }

  const first = Math.min(...valid.map((entry) => entry.timestamp));
  const last = Math.max(...valid.map((entry) => entry.timestamp));
  const calendarDays: string[] = [];
  for (let timestamp = first; timestamp <= last; timestamp += DAY_MS) {
    calendarDays.push(isoDay(timestamp));
  }

  return [
    ...new Set([
      ...calendarDays,
      ...labels.filter((day) => utcDay(day) === null),
    ]),
  ].sort((left, right) => left.localeCompare(right));
}

function utcDay(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const value = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(value) && isoDay(value) === day ? value : null;
}

function isoDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function weekStart(timestamp: number): number {
  const weekday = new Date(timestamp).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  return timestamp - daysSinceMonday * DAY_MS;
}
