/**
 * Stats: local analytics for every connected plan.
 *
 * Codex's tab carries the token-activity ledger — activity tokens, never the
 * quota windows (Home owns those). Every other connected plan reports no token
 * history, so its tab shows its latest window reading and says that is what it
 * is. Local analytics is a preference that defaults on: the only off state is
 * the user's own opt-out, and turning it back on is a button, not a permission
 * gate.
 *
 * Owns the `stats-*` testids. It must not re-render `window-bar` — Home owns
 * that testid, and both views stay mounted, so a duplicate would make every
 * spec selector ambiguous.
 *
 * The tab strip is mounted from app start like Home's, so a click never races
 * a fresh Radix mount. Tab *bodies* mount on the first Stats visit and stay
 * mounted for the rest of the session (the outer div hides via `display:none`),
 * so revisiting Stats renders from cached atom values without re-subscribing.
 */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowClockwise, Fire, Lightning } from "@phosphor-icons/react";

import {
  accountUsageForAtom,
  priceListAtom,
  statsTabAtom,
  subscriptionsAtom,
  usageForAtom,
} from "~/atoms";
import { PANEL, PanelHeader } from "~/components/dashboard/panel";
import { FreshnessPill } from "~/components/usage/provider-status-card";
import { Button } from "~/components/ui/button";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "~/components/ui/chart";
import { Skeleton } from "~/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { ViewHeader } from "~/components/views/view-header";
import * as Ipc from "~/lib/ipc";
import {
  DEFAULT_INPUT_SHARE,
  estimateModelCosts,
  formatUsd,
  planPriceUsd,
  PRICING_PROVIDER_IDS,
  valueRatio,
  type ModelCostEstimate,
  type ModelCostRow,
  type PriceList,
} from "~/lib/pricing";
import {
  calendarDateRange,
  costThresholdDay,
  cumulativeCostSeries,
  providerDailyCostValues,
  rollingSevenDayAverage,
  weeklyModelTimeline,
} from "~/lib/stats-analytics";
import {
  effectiveFreshness,
  formatCountdown,
  formatFreshness,
  formatPlan,
  millisUntilReset,
  ALL_PLANS_TAB,
  statsTabsFrom,
  windowTitle,
  type UsageTab,
} from "~/lib/usage";
import { useClock } from "~/hooks/use-clock";

export function StatsView({ visible }: { readonly visible: boolean }) {
  const selected = useAtomValue(statsTabAtom);
  const setSelected = useAtomSet(statsTabAtom);
  const subscriptions = useAtomValue(subscriptionsAtom);
  const [mounted, setMounted] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (visible && !mounted) {
      setMounted(true);
      setLastRefreshed(Date.now());
    }
  }, [visible, mounted]);

  const tabs = statsTabsFrom(
    AsyncResult.match(subscriptions, {
      onInitial: () => [],
      onSuccess: (result) => result.value,
      onFailure: () => [],
    }),
  );

  const active = tabs.some((tab) => tab.value === selected)
    ? selected
    : ALL_PLANS_TAB.value;

  const connectedKinds = useMemo(
    () =>
      tabs
        .filter((t) => t.kind !== null)
        .map((t) => t.kind as Ipc.ProviderKind),
    [tabs],
  );

  const handleReload = useCallback(() => {
    setRefreshTick((t) => t + 1);
    setLastRefreshed(Date.now());
  }, []);

  return (
    <div
      className={visible ? "flex flex-col gap-4" : "hidden"}
      data-testid="view-stats"
    >
      <div className="flex items-start justify-between gap-4">
        <ViewHeader
          title="Stats"
          subtitle="Local analytics across your connected plans."
        />
        {mounted ? (
          <StatsReloadButton onReload={handleReload} />
        ) : null}
      </div>

      {mounted
        ? connectedKinds.map((kind) => (
            <ProviderRefreshHandler
              key={kind}
              kind={kind}
              tick={refreshTick}
            />
          ))
        : null}

      <Tabs
        value={active}
        onValueChange={setSelected}
        className="flex flex-col gap-4"
      >
        <TabsList className="flex-wrap" aria-label="Connected plans">
          {tabs.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              data-testid={`stats-tab-${tab.value}`}
              data-active={tab.value === active}
            >
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {tabs.map((tab) => (
          <TabsContent key={tab.value} value={tab.value}>
            {mounted ? (
              tab.kind === null && tab.value === ALL_PLANS_TAB.value ? (
                <AllPlansOverview
                  tabs={tabs}
                  lastRefreshed={lastRefreshed}
                />
              ) : (
                <StatsTabBody tab={tab} />
              )
            ) : null}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

/**
 * Every connected plan on one screen: what each one's window looks like, what
 * it has used, and what that would have cost.
 *
 * The tabs beside this one each answer for a single plan. This answers the
 * question a user actually has before opening any of them — *which plan is
 * this, and which one is costing me?*
 *
 * What it deliberately does not do is total. The figures here come from
 * different spans: a provider's rolling window, a year of local rollout logs,
 * whatever sessions OpenCode recorded. Adding them would average a 30-day
 * window into an all-time record and produce a number that is wrong by an
 * amount nobody can state. Each row carries its own span instead, and the
 * footer says why nothing was summed.
 */
export function AllPlansOverview({
  tabs,
  lastRefreshed,
}: {
  readonly tabs: readonly UsageTab[];
  readonly lastRefreshed: number | null;
}) {
  const plans = tabs.filter((tab) => tab.kind !== null);
  const nowMs = useClock();
  const freshnessLabel =
    lastRefreshed !== null
      ? (formatFreshness(lastRefreshed, nowMs) ?? "just now")
      : null;
  const freshnessTone =
    lastRefreshed !== null && nowMs - lastRefreshed > CACHE_STALE_MS
      ? "stale"
      : "live";

  return (
    <section
      className={`${PANEL} flex flex-col gap-4`}
      data-testid="stats-all-plans"
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-sm font-medium text-foreground">
            All plans
          </h2>
          {freshnessLabel !== null ? (
            <FreshnessPill
              freshness={freshnessTone}
              label={freshnessLabel}
              className="text-[11px]"
            />
          ) : null}
        </div>
      </div>
      <p className="-mt-3 text-xs text-muted-foreground">
        One row per connected plan, each with its own window, token total and
        cost.
      </p>
      <div className="flex flex-col gap-3">
        {plans.map((tab) => (
          <PlanSummaryRow
            key={tab.value}
            kind={tab.kind as Ipc.ProviderKind}
            label={tab.label}
          />
        ))}
      </div>
      <p
        className="text-xs text-muted-foreground"
        data-testid="stats-all-plans-not-summed"
      >
        These rows cover different spans — a provider&apos;s rolling window,
        or every session logged on this machine — so they are listed rather
        than summed.
      </p>
    </section>
  );
}

function StatsReloadButton({
  onReload,
}: {
  readonly onReload: () => void;
}) {
  const refreshSubs = useAtomRefresh(subscriptionsAtom);

  const handleClick = useCallback(() => {
    refreshSubs();
    onReload();
  }, [refreshSubs, onReload]);

  return (
    <Button
      variant="ghost"
      size="sm"
      className="shrink-0"
      onClick={handleClick}
      data-testid="stats-reload"
    >
      <ArrowClockwise aria-hidden="true" />
      <span className="hidden sm:inline">Reload</span>
    </Button>
  );
}

function ProviderRefreshHandler({
  kind,
  tick,
}: {
  readonly kind: Ipc.ProviderKind;
  readonly tick: number;
}) {
  const refreshUsage = useAtomRefresh(usageForAtom(kind));
  const refreshAccount = useAtomRefresh(accountUsageForAtom(kind));
  const mountTick = useRef(tick);

  useEffect(() => {
    if (tick === mountTick.current) return;
    refreshUsage();
    refreshAccount();
  }, [tick, refreshUsage, refreshAccount]);

  return null;
}

/**
 * One plan's line in the overview: window fill, tokens, cost, and the span
 * each number covers.
 *
 * The four reads are per-provider session-retained atoms, so a plan that has
 * not been opened still answers from the same read its own tab would use —
 * opening this tab costs no new provider traffic.
 */
function PlanSummaryRow({
  kind,
  label,
}: {
  readonly kind: Ipc.ProviderKind;
  readonly label: string;
}) {
  const snapshotRead = useAtomValue(usageForAtom(kind));
  const accountRead = useAtomValue(accountUsageForAtom(kind));
  const priceList = useAtomValue(priceListAtom);

  const accountPending = AsyncResult.isInitial(accountRead);
  const snapshot = AsyncResult.match(snapshotRead, {
    onInitial: () => null,
    onSuccess: (result) =>
      result.value.find((item) => item.provider === kind) ?? null,
    onFailure: () => null,
  });
  const account = AsyncResult.match(accountRead, {
    onInitial: () => null,
    onSuccess: (result) => result.value,
    onFailure: () => null,
  });

  const windowFill = snapshot?.windows.find(
    (candidate) => candidate.usedPercent > 0,
  );
  const tokens = account?.summary.totalTokens ?? null;
  const local = account?.local ?? null;
  const coverage = coverageOf(account, kind);
  const list = AsyncResult.match(priceList, {
    onInitial: () => null,
    onSuccess: (result) => result.value,
    onFailure: () => null,
  });
  const estimate =
    account !== null &&
    account.local === null &&
    account.models.length > 0 &&
    list !== null
      ? estimateModelCosts(account.models, list, PRICING_PROVIDER_IDS[kind])
      : null;
  const cost = costOf(account, estimate, list);
  const localRequests =
    local === null
      ? null
      : local.models.reduce((sum, model) => sum + model.responses, 0);
  const requests = account?.summary.totalRequests ?? localRequests;
  const peakDay = account?.summary.peakDailyTokens ?? null;
  const peakBucket = (account?.dailyUsageBuckets ?? []).reduce<
    { startDate: string; tokens: number | null } | null
  >(
    (best, bucket) =>
      best === null || (bucket.tokens ?? 0) > (best.tokens ?? 0) ? bucket : best,
    null,
  );
  const peakDayDate = peakBucket?.startDate ?? null;

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-border/70 bg-surface/60 p-3"
      data-testid={`stats-plan-row-${kind}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span
          className="text-xs text-muted-foreground"
          data-testid={`stats-plan-row-${kind}-source`}
        >
          {coverage}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
        {snapshot === null ? (
          <span className="text-muted-foreground">
            {AsyncResult.match(snapshotRead, {
              onInitial: () => "Reading windows…",
              onSuccess: () => "No provider reported a usage window.",
              onFailure: () => "Window unavailable.",
            })}
          </span>
        ) : (
          <span
            className="text-muted-foreground"
            data-testid={`stats-plan-row-${kind}-window`}
          >
            {formatPlan(snapshot.plan)} ·{" "}
            {windowFill === undefined
              ? "no usage in the reported window"
              : `${windowFill.label} ${Math.round(windowFill.usedPercent)}% used`}
          </span>
        )}
        <span
          className="font-medium tabular text-foreground"
          data-testid={`stats-plan-row-${kind}-tokens`}
        >
          {accountPending
            ? "Reading…"
            : tokens !== null
              ? `${formatCompactCount(tokens)} tokens`
              : local !== null
                ? `${formatCompactCount(localTotals(local))} tokens`
                : "No token history"}
        </span>
        <span
          className="font-medium tabular text-foreground"
          data-testid={`stats-plan-row-${kind}-cost`}
        >
          {accountPending ? "Reading…" : cost.cost}
        </span>
        {requests !== null ? (
          <span
            className="text-muted-foreground"
            data-testid={`stats-plan-row-${kind}-requests`}
          >
            {formatCompactCount(requests)} requests
          </span>
        ) : null}
        {peakDay !== null ? (
          <span
            className="text-muted-foreground"
            data-testid={`stats-plan-row-${kind}-peak`}
          >
            {peakDayDate === null
              ? `peak ${formatCompactCount(peakDay)} tokens`
              : `peak ${formatCompactCount(peakDay)} tokens · ${peakDayDate}`}
          </span>
        ) : null}
      </div>
      {accountPending || cost.basis === null ? null : (
        <p
          className="-mt-1 text-[11px] text-muted-foreground"
          data-testid={`stats-plan-row-${kind}-cost-basis`}
        >
          {cost.basis} · not a bill
        </p>
      )}
    </div>
  );
}

function localTotals(local: Ipc.LocalUsage): number {
  return local.models.reduce(
    (sum, model) => sum + model.input + model.output,
    0,
  );
}

/**
 * Where a plan's numbers came from and over what span.
 *
 * A plan that reports its own token history covers a provider-chosen window;
 * one answered from this machine's logs covers every session ever recorded.
 * Those are different claims, and a row that blurred them would be worth less
 * than no row.
 */
function coverageOf(
  account: Ipc.AccountUsage | null,
  kind: Ipc.ProviderKind,
): string {
  if (account === null) return "Reading…";
  if (account.local !== null) {
    const span =
      account.local.firstDay !== null && account.local.lastDay !== null
        ? `${account.local.firstDay} → ${account.local.lastDay}`
        : "every logged session";
    return `${account.local.sessions} local sessions · ${span}`;
  }
  if (account.summary.totalTokens !== null) {
    return account.windowDays !== null
      ? `provider window · ${account.windowDays} days`
      : "provider account total";
  }
  return kind === "codex" || kind === "zai"
    ? "Provider reports no token history."
    : "No token history from this plan.";
}

/**
 * A plan's cost, and where that number came from.
 *
 * Both kinds of plan end up with a figure, because a dash beside a dollar
 * amount on the row above reads as "this plan is free" when it really means
 * "nobody has priced it yet". A provider-reported plan is priced from the
 * model mix it reports, which is an estimate against the bundled list; a plan
 * read from this machine's logs is priced exactly, per response.
 */
function costOf(
  account: Ipc.AccountUsage | null,
  estimate: ModelCostEstimate | null,
  priceList: PriceList | null,
): { cost: string; basis: string | null } {
  if (account === null) return { cost: "—", basis: null };
  const priceListDate =
    priceList === null
      ? "bundled price list date unavailable"
      : `bundled price list updated ${priceList.meta.updated}`;
  if (account.local !== null) {
    if (account.local.costUsd > 0) {
      const unpriced =
        account.local.unpricedTokens > 0
          ? `${formatCompactCount(account.local.unpricedTokens)} tokens remain unpriced`
          : null;
      const basis = `exact per-response API rates · ${priceListDate}`;
      return {
        cost: `≈ ${formatUsd(account.local.costUsd)}`,
        basis: unpriced === null ? basis : `${basis} · ${unpriced}`,
      };
    }
    return {
      cost:
        account.local.unpricedTokens > 0
          ? "Not priced"
          : "No cost recorded",
      basis:
        account.local.unpricedTokens > 0
          ? `${formatCompactCount(account.local.unpricedTokens)} tokens on models the price list does not carry · ${priceListDate}`
          : null,
    };
  }
  if (estimate === null) return { cost: "—", basis: null };
  if (estimate.unpricedTokens > 0) {
    return {
      cost: "Not priced",
      basis: `${formatCompactCount(estimate.unpricedTokens)} tokens on models the price list does not carry · ${priceListDate}`,
    };
  }
  if (estimate.estimatedTotalUsd <= 0) return { cost: "No cost recorded", basis: null };
  return {
    cost: `≈ ${formatUsd(estimate.estimatedTotalUsd)}`,
    basis: `${Math.round(estimate.inputShare * 100)}% input / ${Math.round((1 - estimate.inputShare) * 100)}% output blend · ${priceListDate}`,
  };
}

/** What one plan's tab shows: its stats, or the honest reason there are none. */
function StatsTabBody({ tab }: { readonly tab: UsageTab }) {
  if (tab.kind === null) {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="stats-plan-unreadable"
      >
        This plan is connected in OpenCode, but AgentGauge cannot read its
        stats yet.
      </p>
    );
  }

  if (tab.kind === "codex") {
    return (
      <div className="flex flex-col gap-4">
        <CodexActivity />
        <PlanReading kind={tab.kind} label={tab.label} />
      </div>
    );
  }

  if (TOKEN_HISTORY_PROVIDERS.includes(tab.kind)) {
    return (
      <div className="flex flex-col gap-4">
        <PlanAnalytics kind={tab.kind} label={tab.label} />
        <PlanReading kind={tab.kind} label={tab.label} />
      </div>
    );
  }

  return <PlanReading kind={tab.kind} label={tab.label} />;
}

/**
 * The providers whose Stats tab carries activity analytics.
 *
 * Codex and Z.AI report token history from the provider's own API. MiniMax
 * and Kimi publish none, so their reading comes from the sessions OpenCode
 * recorded locally — different source, same tab. Anything absent keeps reading
 * its windows only, and a provider added here must implement the account-usage
 * read in Rust: the panel is a promise the read has to keep.
 */
const TOKEN_HISTORY_PROVIDERS: readonly Ipc.ProviderKind[] = [
  "codex",
  "zai",
  "minimax",
  "kimi",
];

const CACHE_STALE_MS = 15 * 60_000;

/**
 * Whether an account reading carries anything the provider itself reported.
 *
 * MiniMax and Kimi answer with the local reading alone, and a panel of
 * "not reported" cards over an empty chart would misdescribe that as missing
 * data rather than as the shape of the answer.
 */
export function reportsOwnAnalytics(usage: Ipc.AccountUsage): boolean {
  return (
    usage.models.length > 0 ||
    usage.dailyUsageBuckets.some((bucket) => (bucket.tokens ?? 0) > 0) ||
    usage.summary.totalTokens !== null
  );
}

function LocalSessionStats({ usage }: { readonly usage: Ipc.LocalUsage }) {
  const sessionDays = usage.sessionDays ?? [];
  const sessionCounts = new Map(
    sessionDays.map((item) => [item.day, item.sessions]),
  );
  const sessionChartData = calendarDateRange(
    sessionDays.map((item) => item.day),
  ).map((day) => ({
    day,
    sessions: sessionCounts.get(day) ?? null,
  }));
  const medianTokens = usage.medianTokensPerSession ?? null;
  const compactions = usage.compactions ?? null;

  if (
    sessionDays.length === 0 &&
    medianTokens === null &&
    compactions === null
  ) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3" data-testid="stats-local-session-stats">
      <h4 className="text-xs font-medium text-foreground">Session stats</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <MetricCard
          label="Median tokens per session"
          tokenValue={medianTokens}
          testId="stats-local-median-session"
        />
        <MetricCard
          label="Compactions in readable logs"
          value={
            compactions === null ? "Not reported" : formatCount(compactions)
          }
          testId="stats-local-compactions"
          detail={
            usage.filesUnreadable + usage.filesCompressed > 0
              ? "Some local logs could not be counted."
              : "From the source's readable session records."
          }
        />
      </div>
      {sessionDays.length > 0 ? (
        <div
          className="flex flex-col gap-2"
          data-testid="stats-local-session-chart"
        >
          <ChartContainer
            config={sessionChartConfig}
            className="aspect-auto h-40 w-full"
            aria-label="Locally recorded sessions per day"
          >
            <BarChart
              accessibilityLayer
              data={sessionChartData}
              margin={{ left: 4, right: 4 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="day"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={formatDateTick}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => formatDate(value)}
                    formatter={(value) =>
                      value === null || value === undefined
                        ? "No local record"
                        : formatCount(Number(value))
                    }
                  />
                }
              />
              <Bar
                dataKey="sessions"
                fill="var(--color-sessions)"
                radius={4}
                maxBarSize={28}
              />
            </BarChart>
          </ChartContainer>
          <p className="text-xs text-muted-foreground">
            Session records per day; dates without a local record remain blank,
            not zero.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function ModelMigrationTimeline({
  modelDays,
}: {
  readonly modelDays: readonly Ipc.LocalModelDayUsage[];
}) {
  const timeline = useMemo(
    () =>
      weeklyModelTimeline(
        modelDays.map((model) => ({
          day: model.day,
          modelId: model.id,
          displayName: model.displayName,
          tokens: model.tokens,
        })),
      ),
    [modelDays],
  );
  if (timeline.rows.length === 0 || timeline.series.length === 0) return null;

  const config = timeline.series.reduce<ChartConfig>(
    (result, series, index) => {
      result[series.key] = {
        label: series.displayName,
        color: `var(--chart-${Math.min(index + 1, 5)})`,
      };
      return result;
    },
    {},
  );

  return (
    <div
      className="flex flex-col gap-2"
      data-testid="stats-model-timeline"
    >
      <div className="flex flex-col gap-1">
        <h4 className="text-xs font-medium text-foreground">
          Model mix over time
        </h4>
        <p className="text-xs text-muted-foreground">
          Share of local tokens by UTC week, starting Monday; weeks without a
          local record are omitted.
        </p>
      </div>
      <ChartContainer
        config={config}
        className="aspect-auto h-48 w-full"
        data-testid="stats-model-timeline-chart"
        aria-label={`Weekly model share of local tokens: ${timeline.series
          .map((series) => series.displayName)
          .join(", ")}`}
      >
        <BarChart
          accessibilityLayer
          data={timeline.rows}
          margin={{ left: 4, right: 4 }}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="weekStart"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
            tickFormatter={formatDateTick}
          />
          <YAxis
            domain={[0, 100]}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value: number) => `${value}%`}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(value) => formatDate(value)}
                formatter={(value) => `${Math.round(Number(value))}%`}
              />
            }
          />
          {timeline.series.map((series) => (
            <Bar
              key={series.key}
              dataKey={series.key}
              stackId="weekly-model-share"
              fill={`var(--color-${series.key})`}
              maxBarSize={32}
              isAnimationActive={false}
            />
          ))}
          <ChartLegend
            content={<ChartLegendContent />}
            wrapperStyle={{ paddingTop: 8 }}
          />
        </BarChart>
      </ChartContainer>
    </div>
  );
}

/** The Codex tab: token activity, with the window reading below. */
/**
 * The local log reading: what a harness's own session files say, priced
 * exactly.
 *
 * This is the Codex tab's answer to the two questions the provider's account
 * read cannot answer — which model carried the work, and what it would have
 * cost. The figures are Tier A: the logs record a real per-response token
 * split, so nothing here is blended or assumed.
 *
 * The source line is not decoration. These numbers are read off the user's own
 * machine over a window the provider never states, so the panel names the log
 * count, the span, anything it could not read, and that none of it is a bill.
 */
export function LocalLogPanel({
  usage,
  source = "Codex",
}: {
  readonly usage: Ipc.LocalUsage;
  readonly source?: string;
}) {
  const promptTokens = usage.models.reduce((sum, model) => sum + model.input, 0);
  const cachedTokens = usage.models.reduce(
    (sum, model) => sum + model.cachedInput,
    0,
  );
  const cacheShare = promptTokens > 0 ? cachedTokens / promptTokens : null;
  const totalTokens = usage.models.reduce(
    (sum, model) => sum + model.input + model.output,
    0,
  );
  const pricedCost = usage.models.reduce(
    (sum, model) => sum + (model.costUsd ?? 0),
    0,
  );
  const coverage =
    usage.firstDay !== null && usage.lastDay !== null
      ? `${usage.firstDay} → ${usage.lastDay}`
      : null;

  return (
    <div
      className="flex flex-col gap-4 border-t border-border/70 pt-4"
      data-testid="stats-local-logs"
    >
      <div className="flex flex-col gap-1">
        <h3 className="font-display text-sm font-medium text-foreground">
          Local log reading
        </h3>
        <p className="text-xs text-muted-foreground">
          Read from {source}'s own session logs on this machine — per-model
          tokens and what they would have cost at API prices.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div
          className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/70 bg-surface/60 p-3"
          data-testid="stats-local-cost"
        >
          <span className="text-xs text-muted-foreground">
            If you had paid per token
          </span>
          <span className="text-xl font-semibold tabular text-foreground">
            ≈ {formatUsd(usage.costUsd)}
          </span>
          <span className="text-xs text-muted-foreground">
            {formatCompactCount(totalTokens)} tokens ·{" "}
            {usage.sessions} sessions
          </span>
        </div>
        <div
          className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/70 bg-surface/60 p-3"
          data-testid="stats-local-cache"
        >
          <span className="text-xs text-muted-foreground">Prompt cache</span>
          <span className="text-xl font-semibold tabular text-foreground">
            {cacheShare === null
              ? "—"
              : `${Math.round(cacheShare * 100)}%`}
          </span>
          <span className="text-xs text-muted-foreground">
            {cacheShare === null
              ? "No prompt tokens in these logs"
              : `of ${formatCompactCount(promptTokens)} prompt tokens were cache reads`}
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        {usage.models.map((model) => (
          <LocalModelRow
            key={model.id}
            model={model}
            totalTokens={totalTokens}
            pricedTotal={pricedCost}
          />
        ))}
      </div>
      <ProjectLeaderboard
        projects={usage.projects}
        totalTokens={totalTokens}
      />
      <LocalSessionStats usage={usage} />
      <ModelMigrationTimeline modelDays={usage.modelDays ?? []} />
      <ActivityHeatmap
        days={usage.days}
        source={`The last year, shaded by tokens. ${coverageSentence(usage.firstDay, usage.lastDay, `${usage.sessions} local logs`)}. A gap is a day with no record, not a day with none.`}
      />
      {usage.unpricedTokens > 0 ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="stats-local-unpriced"
        >
          {formatCompactCount(usage.unpricedTokens)} tokens ran on models the
          price list does not carry; they are counted, not priced.
        </p>
      ) : null}
      {usage.filesUnreadable > 0 || usage.filesCompressed > 0 ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="stats-local-gaps"
        >
          {[
            usage.filesUnreadable > 0
              ? `${usage.filesUnreadable} unreadable`
              : null,
            usage.filesCompressed > 0
              ? `${usage.filesCompressed} compressed`
              : null,
          ]
            .filter((part) => part !== null)
            .join(" · ")}{" "}
          log(s) are not in these totals.
        </p>
      ) : null}
      <p
        className="text-xs text-muted-foreground"
        data-testid="stats-local-source"
      >
        {usage.sessions} {source} session logs on this machine
        {coverage !== null ? ` · ${coverage}` : ""} · exact per-response rates ·
        not a bill.
      </p>
    </div>
  );
}

/**
 * The activity heatmap: one cell per day the logs cover.
 *
 * It answers a question the totals cannot — *when* the work happens. The
 * span is the data's own coverage rather than a calendar's, because a year of
 * cells around three weeks of logs would be mostly invented emptiness.
 *
 * Two distinctions the drawing keeps. A day with **no record** is a gap, and a
 * day with **zero tokens** is a recorded zero; collapsing them would make a
 * missing log look like an idle one. Intensity is relative to the busiest day
 * in range, so the grid reads the same whether the span is three weeks or a
 * year.
 */
export function ActivityHeatmap({
  days,
  source = "The last year, shaded by tokens. A gap is a day with no record, not a day with none.",
  until,
}: {
  readonly days: readonly { readonly day: string; readonly tokens: number | null }[];
  readonly source?: string;
  /** The last day drawn. Defaults to today; pinned by tests. */
  readonly until?: string;
}) {
  const recorded = useMemo(
    () => new Map(days.map((day) => [day.day, day.tokens])),
    [days],
  );

  const frame = useRef<HTMLDivElement | null>(null);
  const roomyWeeks = useWeeksThatFit(frame);

  const weeks = useMemo(
    () => buildWeeks(recorded, until ?? todayUtc()).slice(-roomyWeeks),
    [recorded, until, roomyWeeks],
  );

  // Every hook above runs before this. An early return in the middle of them
  // changes how many hooks the component called once the first read lands, and
  // React tears the whole block down when it does.
  //
  // No day records at all means the source reported nothing, and a year of
  // empty cells would be a chart of the absence of data rather than of work.
  if (recorded.size === 0 || weeks.length === 0) return null;

  const activeDays = weeks
    .flat()
    .filter((cell) => (cell.tokens ?? 0) > 0).length;

  return (
    <div className="flex flex-col gap-2" data-testid="stats-activity-heatmap">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-xs font-medium text-foreground">When you worked</h4>
        <span
          className="text-xs text-muted-foreground tabular"
          data-testid="stats-activity-busiest"
        >
          {windowLabel(weeks.length)} · {activeDays} active{" "}
          {activeDays === 1 ? "day" : "days"}
        </span>
      </div>

      <div className="flex gap-1.5">
        <div className="min-w-0 flex-1" ref={frame}>
          <div
            className="grid grid-flow-col grid-rows-7 gap-[3px]"
            style={{
              gridTemplateColumns: `auto repeat(${weeks.length}, minmax(0, 1fr))`,
            }}
            data-testid="stats-activity-grid"
          >
            {WEEKDAY_LABELS.map((label, row) => (
              <span
                key={`weekday-${row}`}
                className="flex h-full items-center text-[9px] leading-none text-muted-foreground/70"
                data-weekday={label === "" ? undefined : label}
                aria-hidden="true"
              >
                {label}
              </span>
            ))}
            {weeks.flat().map((cell) => (
              <span
                key={cell.day}
                className={`aspect-square w-full rounded-[2px] ${HEATMAP_FILL[cell.state]}`}
                data-testid={`stats-activity-cell-${cell.day}`}
                data-row={cell.row}
                data-state={cell.state}
                title={cellTitle(cell)}
              />
            ))}
          </div>
          <div
            className="mt-1 grid grid-flow-col gap-[3px] text-[9px] leading-none text-muted-foreground"
            style={{
              gridTemplateColumns: `auto repeat(${weeks.length}, minmax(0, 1fr))`,
            }}
            data-testid="stats-activity-months"
          >
            <span />
            {weeks.map((week, index) => (
              <span key={week[0]?.day ?? index}>
                {monthLabelAt(weeks, index)}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <p
          className="text-xs text-muted-foreground"
          data-testid="stats-activity-source"
        >
          {source}
        </p>
        <div
          className="flex shrink-0 items-center gap-1 text-[9px] text-muted-foreground"
          data-testid="stats-activity-legend"
        >
          <span>Less</span>
          {(["empty", "low", "mid", "high", "peak"] as const).map((state) => (
            <span
              key={state}
              className={`h-[9px] w-[9px] rounded-[2px] ${HEATMAP_FILL[state]}`}
            />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
}

const DAY_MS = 86_400_000;

/**
 * What the source actually covers, in words.
 *
 * The grid runs back a year, so the span it draws is wider than the span the
 * data covers. Saying so is what keeps a mostly-empty grid from reading as a
 * year of inactivity.
 */
function coverageSentence(
  firstDay: string | null,
  lastDay: string | null,
  what: string,
): string {
  if (firstDay === null || lastDay === null) return `${what}, span unknown`;
  return `${what}, covering ${firstDay} → ${lastDay}`;
}

/** Today as an ISO date, the grid's right edge unless a caller says otherwise. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

type HeatCell = {
  day: string;
  tokens: number | null;
  state: HeatState;
  /**
   * The row this day occupies, Monday first. `Date.getUTCDay` counts Sunday
   * from zero, so the order is rotated by six rather than by one.
   */
  row: number;
};

/** The smallest a cell may get before it stops reading as a cell. */
const MIN_CELL_PX = 9;
const CELL_GAP_PX = 3;
const MAX_WEEKS = 53;

/**
 * How many weeks fit in the space available.
 *
 * A year of columns either shrinks into illegibility or forces the panel to
 * scroll sideways, and a heatmap the reader has to scroll is no longer a year.
 * So the grid keeps its cells at a readable size and shows fewer weeks instead:
 * the full year when there is room, half a year when there is not.
 *
 * A width of zero means the frame has not been measured yet — no layout, as in
 * a unit test — and the full window is the honest default.
 */
function useWeeksThatFit(frame: React.RefObject<HTMLDivElement | null>): number {
  const [count, setCount] = useState(MAX_WEEKS);
  useEffect(() => {
    const node = frame.current;
    if (node === null) return;
    const measure = () => {
      const width = node.getBoundingClientRect().width;
      if (width <= 0) return;
      const perWeek = MIN_CELL_PX + CELL_GAP_PX;
      setCount(Math.max(13, Math.min(MAX_WEEKS, Math.floor(width / perWeek))));
    };
    measure();
    // Without an observer the grid keeps the full window and stops adapting.
    // A missing observer must not take the panel down with it.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [frame]);
  return count;
}

/** The window a grid of this many weeks covers, in words. */
function windowLabel(weeks: number): string {
  if (weeks >= MAX_WEEKS) return "The last year";
  const months = Math.round((weeks * 7) / 30.4);
  return `The last ${months} months`;
}

/**
 * The trailing year, as week columns of seven weekdays.
 *
 * Each cell's row is its weekday, which is what makes a column readable as a
 * week at a glance. The window runs back 52 weeks from the end and starts on
 * the Sunday before that, so the first column is partial rather than shifted —
 * a grid whose rows drift by a day is a grid nobody can read.
 *
 * Days outside the source's coverage stay `no-record` instead of being drawn
 * as zeroes. The contribution-graph convention treats them alike, but "the
 * logs do not cover this day" and "you did not work this day" are different
 * facts and the grid keeps both.
 */
function buildWeeks(
  recorded: ReadonlyMap<string, number | null>,
  until: string,
): HeatCell[][] {
  const end = Date.parse(`${until}T00:00:00Z`);
  if (!Number.isFinite(end)) return [];
  const start = end - 364 * DAY_MS;
  // Back up to the Sunday that opens the week containing `start`.
  const aligned = start - new Date(start).getUTCDay() * DAY_MS;
  const peak = peakOf(recorded);

  const weeks: HeatCell[][] = [];
  for (let time = aligned; time <= end; time += DAY_MS) {
    const day = new Date(time).toISOString().slice(0, 10);
    const tokens = recorded.get(day) ?? null;
    const cell: HeatCell = {
      day,
      tokens,
      state: tokens === null ? "no-record" : intensityOf(tokens, peak),
      row: (new Date(time).getUTCDay() + 6) % 7,
    };
    if (weeks.length === 0 || time % (7 * DAY_MS) === aligned % (7 * DAY_MS)) {
      weeks.push([cell]);
    } else {
      weeks[weeks.length - 1].push(cell);
    }
  }
  return weeks;
}

/** The busiest recorded day, which is the top of the shade scale. */
function peakOf(recorded: ReadonlyMap<string, number | null>): number {
  let peak = 0;
  for (const tokens of recorded.values()) {
    if (tokens !== null && tokens > peak) peak = tokens;
  }
  return peak;
}

/** The month to print above a column, or an empty string to leave it blank. */
function monthLabelAt(weeks: readonly HeatCell[][], index: number): string {
  const week = weeks[index];
  if (week === undefined || week.length === 0) return "";
  const month = week[0].day.slice(0, 7);
  const previous = weeks[index - 1]?.[0]?.day.slice(0, 7);
  if (previous === month) return "";
  return MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? "";
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** What a cell says on hover, which is where the gap distinction surfaces. */
function cellTitle(cell: HeatCell): string {
  if (cell.tokens === null) return `${cell.day}: no record`;
  return `${cell.day}: ${formatCompactCount(cell.tokens)} tokens`;
}

/**
 * A provider's daily buckets as the heatmap's day series.
 *
 * A day the provider did not report a count for stays a gap rather than
 * becoming a zero, which is the same distinction the local series keeps.
 */
function reportedDays(usage: Ipc.AccountUsage) {
  return [...usage.dailyUsageBuckets]
    .sort((left, right) => left.startDate.localeCompare(right.startDate))
    .map((bucket) => ({ day: bucket.startDate, tokens: bucket.tokens }));
}

/** A day's shade, relative to the busiest day in range. */
function intensityOf(tokens: number, peak: number): HeatState {
  if (tokens <= 0) return "empty";
  if (peak <= 0) return "low";
  const share = tokens / peak;
  if (share >= 0.75) return "peak";
  if (share >= 0.45) return "high";
  if (share >= 0.2) return "mid";
  return "low";
}

type HeatState = "no-record" | "empty" | "low" | "mid" | "high" | "peak";

/**
 * Heatmap fills, from theme tokens only.
 *
 * `accent-glass` marks a day with no record: the same chrome the share bars
 * sit on, so a gap reads as absence rather than as another shade of activity.
 */
/**
 * Cell fills, from theme tokens only.
 *
 * Four activity shades over a quiet base, the way a contribution graph reads:
 * the eye compares a day's colour against its neighbours, not against an
 * absolute number. `no-record` sits one step *below* the quiet base, so a day
 * missing from the logs reads as a hole in the grid rather than as another
 * quiet day. That distinction is the one thing this block refuses to flatten.
 */
const HEATMAP_FILL: Record<HeatState, string> = {
  "no-record": "bg-muted/45",
  empty: "bg-muted",
  low: "bg-chart-1/25",
  mid: "bg-chart-1/45",
  high: "bg-chart-1/70",
  peak: "bg-chart-1",
};

/** Weekday labels, in the grid's row order. Every other row stays blank so the
 * labels align with the cells without crowding the block. */
const WEEKDAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""] as const;

/** One model's row in the local reading: token share against exact cost share. */
function LocalModelRow({
  model,
  totalTokens,
  pricedTotal,
}: {
  readonly model: Ipc.LocalModelUsage;
  readonly totalTokens: number;
  readonly pricedTotal: number;
}) {
  const tokens = model.input + model.output;
  const tokenSharePct =
    totalTokens > 0 ? Math.round((tokens / totalTokens) * 100) : 0;
  const costSharePct =
    model.costUsd !== null && pricedTotal > 0
      ? Math.round((model.costUsd / pricedTotal) * 100)
      : null;

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border/70 bg-surface/60 p-3"
      data-testid={`stats-local-model-${model.id}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-foreground">
          {model.displayName}
        </span>
        <span className="text-sm font-semibold tabular text-foreground">
          {model.costUsd !== null
            ? `≈ ${formatUsd(model.costUsd)}`
            : "No reference price"}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <ShareBar
          label="Tokens"
          widthPercent={tokenSharePct}
          caption={`${tokenSharePct}% of tokens · ${formatCompactCount(tokens)}`}
          barClassName="bg-chart-1"
        />
        {costSharePct !== null ? (
          <ShareBar
            label="Est. cost"
            widthPercent={costSharePct}
            caption={`${costSharePct}% of est. cost`}
            barClassName="bg-chart-2"
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The project leaderboard: which working directory the tokens went to.
 *
 * Ranked by tokens, with the cost share beside it where it is known. A
 * project whose models the catalog could not price shows its token share
 * alone — a `$0` there would read as free rather than as unknown, which is the
 * same lie the model mix avoids.
 */
export function ProjectLeaderboard({
  projects,
  totalTokens,
}: {
  readonly projects: readonly Ipc.LocalProjectUsage[];
  readonly totalTokens: number;
}) {
  // Re-sorted rather than trusting the caller's order. Both readers already
  // rank their rows, but a leaderboard that silently showed whatever order it
  // was handed would be wrong in a way nobody would notice.
  const ranked = useMemo(
    () =>
      [...projects].sort(
        (left, right) =>
          right.input + right.output - (left.input + left.output) ||
          left.name.localeCompare(right.name),
      ),
    [projects],
  );

  if (ranked.length === 0) return null;

  const pricedTotal = projects.reduce(
    (sum, project) => sum + (project.costUsd ?? 0),
    0,
  );

  return (
    <div className="flex flex-col gap-2" data-testid="stats-projects">
      <h4 className="text-xs font-medium text-foreground">Which project</h4>
      {ranked.map((project) => {
        const tokens = project.input + project.output;
        const tokenSharePct =
          totalTokens > 0 ? Math.round((tokens / totalTokens) * 100) : 0;
        const costSharePct =
          project.costUsd !== null && pricedTotal > 0
            ? Math.round((project.costUsd / pricedTotal) * 100)
            : null;
        return (
          <div
            key={project.name}
            className="flex flex-col gap-1.5"
            data-testid="stats-project-row"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="truncate text-sm text-foreground">
                {project.name}
              </span>
              <span className="text-xs text-muted-foreground tabular">
                {project.costUsd !== null
                  ? `≈ ${formatUsd(project.costUsd)}`
                  : `${formatCompactCount(tokens)} tokens`}
              </span>
            </div>
            <ShareBar
              label="Tokens"
              widthPercent={tokenSharePct}
              caption={`${tokenSharePct}% of tokens · ${formatCompactCount(tokens)} · ${project.responses} responses`}
              barClassName="bg-chart-1"
            />
            {costSharePct !== null ? (
              <ShareBar
                label="Est. cost"
                widthPercent={costSharePct}
                caption={`${costSharePct}% of est. cost`}
                barClassName="bg-chart-2"
              />
            ) : null}
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        Ranked by tokens, from the directory each turn ran in. A project with
        no reference price shows its token share alone.
      </p>
    </div>
  );
}

function CodexActivity() {
  const usage = useAtomValue(accountUsageForAtom("codex"));
  const refresh = useAtomRefresh(accountUsageForAtom("codex"));

  return (
    <section
      className={`${PANEL} flex flex-col gap-4`}
      data-testid="stats-account-analytics"
    >
      <PanelHeader
        title="Token activity"
        testId="stats-analytics-refresh"
        onRefresh={refresh}
      />
      <p className="-mt-3 text-xs text-muted-foreground">
        Reported by Codex · activity tokens only, not plan credits or
        quota-window history.
      </p>
      {AsyncResult.match(usage, {
        onInitial: () => <AnalyticsLoadingSkeleton />,
        onSuccess: (result) => (
          <>
            <AnalyticsContent usage={result.value} refreshing={result.waiting} />
            {result.value.local !== null ? (
              <LocalLogPanel usage={result.value.local} />
            ) : null}
          </>
        ),
        onFailure: () => (
          <p
            className="text-sm text-muted-foreground"
            data-testid="stats-analytics-unavailable"
          >
            Codex account activity is unavailable. Your usage-window readings
            are not affected.
          </p>
        ),
      })}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3">
        <p
          className="text-xs text-muted-foreground"
          data-testid="stats-analytics-source"
        >
          Source: Codex app-server · read locally at{" "}
          {AsyncResult.match(usage, {
            onInitial: () => "—",
            onSuccess: (result) => formatAbsolute(result.value.fetchedAt),
            onFailure: () => "—",
          })}
        </p>
      </div>
    </section>
  );
}

/**
 * Another plan's token-activity panel.
 *
 * The provider's own monitor API reports the daily series, so this is the
 * same diagram Codex's tab carries, labelled with the window the provider
 * actually reported. Below it sits the plan's window reading, which answers a
 * different question and stays.
 */
function PlanAnalytics({
  kind,
  label,
}: {
  readonly kind: Ipc.ProviderKind;
  readonly label: string;
}) {
  const usage = useAtomValue(accountUsageForAtom(kind));
  const refresh = useAtomRefresh(accountUsageForAtom(kind));
  const priceList = useAtomValue(priceListAtom);
  const readings = useAtomValue(usageForAtom(kind));
  const catalog = AsyncResult.match(priceList, {
    onInitial: () => null,
    onSuccess: (result) => result.value,
    onFailure: () => null,
  });
  const pricingState = AsyncResult.match(priceList, {
    onInitial: () => "loading" as const,
    onSuccess: () => "ready" as const,
    onFailure: () => "failed" as const,
  });
  const plan = AsyncResult.match(readings, {
    onInitial: () => null,
    onSuccess: (result) =>
      result.value.find((item) => item.provider === kind)?.plan ?? null,
    onFailure: () => null,
  });

  return (
    <section
      className={`${PANEL} flex flex-col gap-4`}
      data-testid="stats-plan-analytics"
    >
      <PanelHeader
        title="Token activity"
        testId="stats-plan-analytics-refresh"
        onRefresh={refresh}
      />
      <p className="-mt-3 text-xs text-muted-foreground">
        Reported by {label} · activity tokens and model calls in the reported
        window, not plan credits or quota-window history.
      </p>
      {AsyncResult.match(usage, {
        onInitial: () => <AnalyticsLoadingSkeleton />,
        onSuccess: (result) => (
          <>
            {reportsOwnAnalytics(result.value) ? (
              <AnalyticsContent usage={result.value} refreshing={result.waiting} />
            ) : (
              <p
                className="text-sm text-muted-foreground"
                data-testid="stats-plan-no-provider-analytics"
              >
                {label} publishes no token activity of its own. What follows is
                read from this machine&apos;s OpenCode session logs.
              </p>
            )}
            <CostTrajectory
              usage={result.value}
              kind={kind}
              label={label}
              plan={plan}
              pricingState={pricingState}
              priceList={catalog}
            />
            {result.value.local !== null && result.value.models.length === 0 ? (
              <LocalLogPanel usage={result.value.local} source="OpenCode" />
            ) : result.value.local === null &&
              result.value.dailyUsageBuckets.length > 0 ? (
              <ActivityHeatmap
                days={reportedDays(result.value)}
                source={`The last year, shaded by tokens. ${coverageSentence(
                  result.value.dailyUsageBuckets[0]?.startDate ?? null,
                  result.value.dailyUsageBuckets[
                    result.value.dailyUsageBuckets.length - 1
                  ]?.startDate ?? null,
                  `${label}'s own ${result.value.windowDays ?? "reported"} days`,
                )}.`}
              />
            ) : null}
            {result.value.models.length > 0 ? (
              <ModelMixBlock
                kind={kind}
                models={result.value.models}
                windowDays={result.value.windowDays}
                plan={AsyncResult.match(readings, {
                  onInitial: () => null,
                  onSuccess: (reading) =>
                    reading.value.find((item) => item.provider === kind)
                      ?.plan ?? null,
                  onFailure: () => null,
                })}
                pricingState={AsyncResult.match(priceList, {
                  onInitial: () => "loading" as const,
                  onSuccess: () => "ready" as const,
                  onFailure: () => "failed" as const,
                })}
                priceList={AsyncResult.match(priceList, {
                  onInitial: () => null,
                  onSuccess: (result2) => result2.value,
                  onFailure: () => null,
                })}
              />
            ) : null}
          </>
        ),
        onFailure: () => (
          <p
            className="text-sm text-muted-foreground"
            data-testid="stats-plan-analytics-unavailable"
          >
            {label} activity is unavailable. Your usage-window readings are
            not affected.
          </p>
        ),
      })}
      <p
        className="text-xs text-muted-foreground"
        data-testid="stats-plan-analytics-source"
      >
        Source: {label} monitor API · read locally at{" "}
        {AsyncResult.match(usage, {
          onInitial: () => "—",
          onSuccess: (result) => formatAbsolute(result.value.fetchedAt),
          onFailure: () => "—",
        })}
      </p>
    </section>
  );
}

/**
 * A plan's window reading, as its tab describes them.
 *
 * For MiniMax/Kimi this is the whole tab — they publish no token history, and
 * the panel says so rather than presenting percentages as activity. For the
 * token-history providers it rides *below* the analytics: the windows answer
 * "how full is the plan", the chart answers "what did the tokens do", and
 * neither substitutes for the other. The atom is the same session-retained one
 * Home reads, so a plan read once is not fetched again just because Stats
 * opened.
 */
function PlanReading({
  kind,
  label,
}: {
  readonly kind: Ipc.ProviderKind;
  readonly label: string;
}) {
  const usage = useAtomValue(usageForAtom(kind));
  const refresh = useAtomRefresh(usageForAtom(kind));
  const nowMs = useClock();

  return (
    <section
      className={`${PANEL} flex flex-col gap-4`}
      data-testid="stats-plan-reading"
    >
      <PanelHeader
        title="Plan reading"
        testId="stats-plan-refresh"
        onRefresh={refresh}
      />
      <p className="-mt-3 text-xs text-muted-foreground">
        {TOKEN_HISTORY_PROVIDERS.includes(kind)
          ? `${label}'s latest window readings, reported beside its token activity.`
          : "This plan does not report token history; these are its latest window readings."}
      </p>
      {AsyncResult.match(usage, {
        onInitial: () => <ReadingLoadingSkeleton />,
        onSuccess: (result) => {
          const snapshot = result.value.find(
            (item) => item.provider === kind,
          );
          if (!snapshot) {
            return (
              <p className="text-sm text-muted-foreground">
                No provider reported any usage.
              </p>
            );
          }
          return (
            <ReadingBody
              snapshot={snapshot}
              nowMs={nowMs}
              refreshing={result.waiting}
            />
          );
        },
        onFailure: () => (
          <p
            className="text-sm text-muted-foreground"
            data-testid="stats-reading-unavailable"
          >
            This plan's reading could not be fetched. Your other readings are
            not affected.
          </p>
        ),
      })}
    </section>
  );
}

/** One plan's reading: freshness, the plan, and every window as a card. */
function ReadingBody({
  snapshot,
  nowMs,
  refreshing,
}: {
  readonly snapshot: Ipc.UsageSnapshot;
  readonly nowMs: number;
  readonly refreshing: boolean;
}) {
  const freshness = effectiveFreshness(snapshot, nowMs);
  const freshnessLabel =
    freshness === "unavailable"
      ? "Unavailable"
      : (formatFreshness(snapshot.fetchedAt, nowMs) ?? "Just now");

  return (
    <div className="flex flex-col gap-4">
      {refreshing ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="stats-reading-refreshing"
        >
          Refreshing · showing the previous reading until it completes.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <FreshnessPill freshness={freshness} label={freshnessLabel} />
        {snapshot.permission === "blocked" && (
          <FreshnessPill freshness="unavailable" label="Usage blocked" />
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Plan"
          value={formatPlan(snapshot.plan)}
          testId="stats-plan-name"
        />
        {snapshot.windows.map((usageWindow) => (
          <MetricCard
            key={usageWindow.label}
            label={windowTitle(usageWindow.label, usageWindow.durationMins)}
            value={`${usageWindow.usedPercent}% used`}
            detail={`resets in ${
              formatCountdown(
                millisUntilReset(usageWindow.resetsAt, nowMs),
              ) ?? "—"
            }`}
            testId={`stats-plan-window-used-${usageWindow.label}`}
          />
        ))}
      </div>
      {snapshot.reason ? (
        <p className="text-sm text-muted-foreground">{snapshot.reason}</p>
      ) : (
        <p
          className="text-xs text-muted-foreground"
          data-testid="stats-plan-source"
        >
          Source: {snapshot.source}
        </p>
      )}
    </div>
  );
}

const sessionChartConfig = {
  sessions: { label: "Sessions", color: "var(--chart-1)" },
} satisfies ChartConfig;

const activityChartConfig = {
  tokens: { label: "Tokens", color: "var(--chart-1)" },
  rollingAverage: { label: "7-day average", color: "var(--chart-2)" },
} satisfies ChartConfig;

function AnalyticsContent({
  usage,
  refreshing,
}: {
  readonly usage: Ipc.AccountUsage;
  readonly refreshing: boolean;
}) {
  const buckets = [...usage.dailyUsageBuckets].sort((left, right) =>
    left.startDate.localeCompare(right.startDate),
  );
  const tokensByDay = new Map(
    buckets.map((bucket) => [bucket.startDate, bucket.tokens]),
  );
  const chartData = rollingSevenDayAverage(
    calendarDateRange(buckets.map((bucket) => bucket.startDate)).map((day) => ({
      day,
      tokens: tokensByDay.get(day) ?? null,
    })),
  ).map((bucket) => ({
    date: bucket.day,
    tokens: bucket.tokens,
    rollingAverage: bucket.rollingAverage,
  }));
  const knownBuckets = buckets.filter((bucket) => bucket.tokens !== null);
  const range = buckets.length
    ? `${buckets[0].startDate} – ${buckets[buckets.length - 1].startDate}`
    : "No daily history reported";

  return (
    <div className="flex flex-col gap-4">
      {refreshing ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="stats-analytics-refreshing"
        >
          Refreshing · showing the previous reading until it completes.
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label={
            usage.windowDays !== null
              ? `Tokens in ${usage.windowDays} days`
              : "Lifetime tokens"
          }
          tokenValue={usage.summary.totalTokens}
          testId="stats-total-tokens"
        />
        {usage.summary.totalRequests !== null ? (
          <MetricCard
            label={
              usage.windowDays !== null
                ? `Model calls in ${usage.windowDays} days`
                : "Model calls"
            }
            value={formatCount(usage.summary.totalRequests)}
            testId="stats-total-requests"
          />
        ) : null}
        <MetricCard
          label="Peak day"
          tokenValue={usage.summary.peakDailyTokens}
          testId="stats-peak-daily"
        />
        <MetricCard
          label="Current streak"
          value={formatDays(usage.summary.currentStreakDays)}
          testId="stats-current-streak"
          icon={<Fire aria-hidden="true" className="size-4" />}
        />
        <MetricCard
          label="Longest streak"
          value={formatDays(usage.summary.longestStreakDays)}
          testId="stats-longest-streak"
          icon={<Lightning aria-hidden="true" className="size-4" />}
        />
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="font-display text-sm font-medium text-foreground">Daily tokens</h3>
        <p
          className="text-xs text-muted-foreground"
          data-testid="stats-activity-coverage"
        >
          Reported dates: {range}
        </p>
      </div>
      {knownBuckets.length === 0 ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="stats-no-daily-usage"
        >
          Codex has not provided daily token buckets for this account.
        </p>
      ) : (
        <ChartContainer
          config={activityChartConfig}
          className="aspect-auto h-56 w-full"
          data-testid="stats-daily-chart"
          aria-label={`Daily Codex token activity, ${range}`}
        >
          <ComposedChart
            accessibilityLayer
            data={chartData}
            margin={{ left: 4, right: 4 }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
              tickFormatter={(value: string) => formatDateTick(value)}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(value) => formatDate(value)}
                  formatter={(value, name) =>
                    name === "rollingAverage"
                      ? rollingAverageTooltipFormatter(value)
                      : tokenTooltipFormatter(value)
                  }
                />
              }
            />
            <Bar
              dataKey="tokens"
              fill="var(--color-tokens)"
              radius={4}
              maxBarSize={28}
            />
            <Line
              type="monotone"
              dataKey="rollingAverage"
              stroke="var(--color-rollingAverage)"
              strokeWidth={2}
              dot={false}
              activeDot={false}
              connectNulls={false}
            />
          </ComposedChart>
        </ChartContainer>
      )}
      <p
        className="text-xs text-muted-foreground"
        data-testid="stats-rolling-average-note"
      >
        Line: 7-day average, shown after seven consecutive reported dates.
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span data-testid="stats-reported-total">
          {knownBuckets.length === buckets.length
            ? `Tokens in reported days: ${formatCount(knownBuckets.reduce((sum, bucket) => sum + (bucket.tokens ?? 0), 0))}`
            : `Partial daily totals: ${formatCount(knownBuckets.reduce((sum, bucket) => sum + (bucket.tokens ?? 0), 0))}`}
        </span>
        {usage.summary.longestRunningTurnSec !== null ? (
          <span>
            Longest running turn:{" "}
            {formatDuration(usage.summary.longestRunningTurnSec)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

const costTrajectoryConfig = {
  cumulativeUsd: { label: "Cumulative estimate", color: "var(--chart-1)" },
  planPrice: { label: "Monthly plan price", color: "var(--chart-2)" },
  breakEven: { label: "Break-even", color: "var(--chart-3)" },
} satisfies ChartConfig;

function CostTrajectory({
  usage,
  kind,
  label,
  plan,
  pricingState,
  priceList,
}: {
  readonly usage: Ipc.AccountUsage;
  readonly kind: Ipc.ProviderKind;
  readonly label: string;
  readonly plan: Ipc.PlanKind | null;
  readonly pricingState: "loading" | "ready" | "failed";
  readonly priceList: PriceList | null;
}) {
  const modelDays = usage.modelDailyUsage ?? [];
  const dailyCosts = useMemo(
    () =>
      priceList === null
        ? []
        : providerDailyCostValues(
            modelDays,
            usage.dailyUsageBuckets.map((bucket) => ({
              day: bucket.startDate,
              tokens: bucket.tokens,
            })),
            priceList,
            PRICING_PROVIDER_IDS[kind],
          ),
    [kind, modelDays, priceList, usage.dailyUsageBuckets],
  );
  const series = useMemo(() => cumulativeCostSeries(dailyCosts), [dailyCosts]);
  const monthlyPlanPrice =
    priceList === null
      ? null
      : planPriceUsd(priceList, PRICING_PROVIDER_IDS[kind], plan);
  const breakEvenDay = costThresholdDay(series, monthlyPlanPrice);
  const knownValues = series.flatMap((day) =>
    day.cumulativeUsd === null ? [] : [day.cumulativeUsd],
  );
  const incompleteFrom =
    series.find((day) => day.incompleteFrom !== null)?.incompleteFrom ?? null;
  const yMaximum = Math.max(monthlyPlanPrice ?? 0, ...knownValues, 0) * 1.1 || 1;
  const breakEvenNote =
    breakEvenDay !== null
      ? ` Crossed the monthly plan price on ${formatDateTick(breakEvenDay)}.`
      : monthlyPlanPrice === 0
        ? " The listed plan price is $0/month, so break-even is not applicable."
        : incompleteFrom !== null
          ? ` Break-even is unknown because pricing coverage is incomplete from ${formatDateTick(incompleteFrom)}.`
          : " The estimate did not reach the monthly plan price in this reported window.";

  if (modelDays.length === 0) return null;

  return (
    <div className="flex flex-col gap-2" data-testid="stats-cost-trajectory">
      <div className="flex flex-col gap-1">
        <h4 className="text-xs font-medium text-foreground">
          Estimated cost trajectory
        </h4>
        <p className="text-xs text-muted-foreground">
          {label}&apos;s daily model totals priced at API rates; compared with the
          flat monthly plan price.
        </p>
      </div>
      {priceList === null ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="stats-cost-trajectory-unavailable"
        >
          {pricingState === "loading"
            ? "Waiting for the reference price list."
            : "The reference price list is unavailable; no cost line is shown."}
        </p>
      ) : monthlyPlanPrice === null ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="stats-cost-trajectory-unavailable"
        >
          This plan has no monthly price reference in the bundled price list.
        </p>
      ) : knownValues.length === 0 ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="stats-cost-trajectory-unavailable"
        >
          Daily model totals do not fully match the reported token buckets, or
          a model has no reference price. A cumulative estimate is not available.
        </p>
      ) : (
        <>
          <ChartContainer
            config={costTrajectoryConfig}
            className="aspect-auto h-56 w-full"
            data-testid="stats-cost-trajectory-chart"
            aria-label={`${label} cumulative API-equivalent cost and monthly plan price`}
          >
            <ComposedChart
              accessibilityLayer
              data={series}
              margin={{ left: 8, right: 12, top: 8 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="day"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={formatDateTick}
              />
              <YAxis
                domain={[0, yMaximum]}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value: number) => formatUsd(value)}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => formatDate(value)}
                    formatter={(value) => formatUsd(Number(value))}
                  />
                }
              />
              <ReferenceLine
                y={monthlyPlanPrice}
                stroke="var(--color-planPrice)"
                strokeDasharray="4 4"
                label={{
                  value: "Monthly plan price",
                  position: "insideTopRight",
                  fill: "var(--muted-foreground)",
                }}
              />
              {breakEvenDay !== null ? (
                <ReferenceLine
                  x={breakEvenDay}
                  stroke="var(--color-breakEven)"
                  strokeDasharray="3 3"
                  label={{
                    value: "Break-even",
                    position: "insideTopLeft",
                    fill: "var(--muted-foreground)",
                  }}
                />
              ) : null}
              <Line
                type="monotone"
                dataKey="cumulativeUsd"
                stroke="var(--color-cumulativeUsd)"
                strokeWidth={2}
                dot={false}
                connectNulls={false}
              />
            </ComposedChart>
          </ChartContainer>
          <p
            className="text-xs text-muted-foreground"
            data-testid="stats-cost-trajectory-summary"
          >
            {Math.round(DEFAULT_INPUT_SHARE * 100)}% input / {Math.round((1 - DEFAULT_INPUT_SHARE) * 100)}% output estimate · price list updated {priceList.meta.updated} ·
            not a bill.
            {breakEvenNote}
          </p>
          {incompleteFrom !== null ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="stats-cost-trajectory-gap"
            >
              Cumulative totals stop at {formatDateTick(incompleteFrom)} because
              daily cost coverage is incomplete.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * The model mix: which models carried the tokens, and what that mix would
 * have cost at API prices.
 *
 * The two lenses are the point — a cheap model can carry most of the volume
 * for a sliver of the dollars, and only seeing both shares says so. Estimates
 * are Tier B (the provider reports totals per model, no input/output split),
 * so the input-share assumption and the price list's date ship with every
 * dollar figure, and a model the list does not carry is unpriced tokens —
 * never $0.
 */
export function ModelMixBlock({
  kind,
  models,
  windowDays,
  plan,
  pricingState,
  priceList,
}: {
  readonly kind: Ipc.ProviderKind;
  readonly models: readonly Ipc.ModelUsage[];
  readonly windowDays: number | null;
  readonly plan: Ipc.PlanKind | null;
  readonly pricingState: "loading" | "ready" | "failed";
  readonly priceList: PriceList | null;
}) {
  if (pricingState === "loading") {
    return <ModelMixSkeleton />;
  }

  const providerId = PRICING_PROVIDER_IDS[kind];
  const estimate =
    pricingState === "ready" && priceList !== null
      ? estimateModelCosts(models, priceList, providerId)
      : null;
  const planPrice =
    estimate !== null && plan !== null
      ? planPriceUsd(priceList as PriceList, providerId, plan)
      : null;
  const ratio =
    estimate !== null ? valueRatio(estimate.estimatedTotalUsd, planPrice) : null;
  const pricedTotal = estimate?.estimatedTotalUsd ?? 0;

  return (
    <div
      className="flex flex-col gap-4 border-t border-border/70 pt-4"
      data-testid="stats-model-mix"
    >
      <div className="flex flex-col gap-1">
        <h3 className="font-display text-sm font-medium text-foreground">
          Model mix
        </h3>
        <p className="text-xs text-muted-foreground">
          Tokens and estimated API-equivalent cost per model, in the reported
          window.
        </p>
      </div>
      {pricingState === "failed" ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="stats-pricing-unavailable"
        >
          The price list could not be read, so token shares are shown without
          cost estimates.
        </p>
      ) : null}
      {ratio !== null && estimate !== null ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div
            className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/70 bg-surface/60 p-3"
            data-testid="stats-est-cost"
          >
            <span className="text-xs text-muted-foreground">
              If you had paid per token
            </span>
            <span className="text-xl font-semibold tabular text-foreground">
              ≈ {formatUsd(estimate.estimatedTotalUsd)}
            </span>
            <span className="text-xs text-muted-foreground">
              API-equivalent in {windowDays ?? "the reported"} days
            </span>
          </div>
          <div
            className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/70 bg-surface/60 p-3"
            data-testid="stats-value-ratio"
          >
            <span className="text-xs text-muted-foreground">Plan value</span>
            <span className="text-xl font-semibold tabular text-foreground">
              ≈ {Math.round(ratio)}× the {formatPlan(plan)} price
            </span>
            <span className="text-xs text-muted-foreground">
              {formatUsd(planPrice ?? 0)}/month plan, estimates only — not a bill
            </span>
          </div>
        </div>
      ) : null}
      <div className="flex flex-col gap-3">
        {models.map((model) => (
          <ModelMixRow
            key={model.id}
            model={model}
            row={
              estimate?.rows.find((candidate) => candidate.id === model.id) ??
              null
            }
            pricedTotal={pricedTotal}
          />
        ))}
      </div>
      {estimate !== null && estimate.unpricedTokens > 0 ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="stats-unpriced-tokens"
        >
          {formatCount(estimate.unpricedTokens)} tokens ran on models the price
          list does not carry; they are counted, not priced.
        </p>
      ) : null}
      <p
        className="text-xs text-muted-foreground"
        data-testid="stats-model-mix-source"
      >
        {estimate !== null
          ? `Estimates: reported tokens × price list ${priceList?.meta.updated} · assumes ${Math.round(estimate.inputShare * 100)}% input · not a bill.`
          : "Token shares as reported; no estimates without the price list."}
      </p>
    </div>
  );
}

/** One model's row: name, both shares, and its estimate (or why there is none). */
function ModelMixRow({
  model,
  row,
  pricedTotal,
}: {
  readonly model: Ipc.ModelUsage;
  readonly row: ModelCostRow | null;
  readonly pricedTotal: number;
}) {
  const tokenSharePct = Math.round((row?.shareOfTokens ?? 0) * 100);
  const costSharePct =
    row?.costUsd !== null && row?.costUsd !== undefined && pricedTotal > 0
      ? Math.round((row.costUsd / pricedTotal) * 100)
      : null;

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border/70 bg-surface/60 p-3"
      data-testid={`stats-model-row-${model.id}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-foreground">
          {model.displayName}
        </span>
        <span className="text-sm font-semibold tabular text-foreground">
          {row?.costUsd != null ? `≈ ${formatUsd(row.costUsd)}` : "No reference price"}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <ShareBar
          label="Tokens"
          widthPercent={tokenSharePct}
          caption={`${tokenSharePct}% of tokens`}
          barClassName="bg-chart-1"
        />
        {costSharePct !== null ? (
          <ShareBar
            label="Est. cost"
            widthPercent={costSharePct}
            caption={`${costSharePct}% of est. cost`}
            barClassName="bg-chart-2"
          />
        ) : null}
      </div>
    </div>
  );
}

/** A labelled share bar: the model mix's two lenses read as lengths. */
function ShareBar({
  label,
  widthPercent,
  caption,
  barClassName,
}: {
  readonly label: string;
  readonly widthPercent: number;
  readonly caption: string;
  readonly barClassName: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="w-16 shrink-0">{label}</span>
      <div
        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-accent-glass"
        role="presentation"
      >
        <div
          className={`h-full rounded-full ${barClassName}`}
          style={{ width: `${Math.min(100, Math.max(0, widthPercent))}%` }}
        />
      </div>
      <span className="w-24 shrink-0 text-right tabular">{caption}</span>
    </div>
  );
}

/** The mix's shape while the price list loads. */
function ModelMixSkeleton() {
  return (
    <div
      className="flex flex-col gap-4 border-t border-border/70 pt-4"
      data-testid="stats-model-mix-skeleton"
    >
      <Skeleton className="h-4 w-20" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
      </div>
      <Skeleton className="h-16 rounded-lg" />
    </div>
  );
}

function MetricCard({
  label,
  value,
  tokenValue,
  testId,
  icon,
  detail,
}: {
  readonly label: string;
  readonly value?: string;
  /** Token counts render compact-first, hover the exact number, click to pin. */
  readonly tokenValue?: number | null;
  readonly testId: string;
  readonly icon?: ReactNode;
  readonly detail?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/70 bg-surface/60 p-3">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </span>
      {tokenValue !== undefined ? (
        <TokenCount value={tokenValue} testId={testId} />
      ) : (
        <span
          className="text-xl font-semibold tabular text-foreground"
          data-testid={testId}
        >
          {value}
        </span>
      )}
      {detail ? (
        <span className="text-xs text-muted-foreground">{detail}</span>
      ) : null}
    </div>
  );
}

/**
 * One metric card's shape while its reading is on the way.
 *
 * Both stat bodies lay their numbers out in the same four-across card grid,
 * so one placeholder card serves either.
 */
function MetricCardSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/70 bg-surface/60 p-3">
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-7 w-24" />
    </div>
  );
}

function MetricCardsSkeleton({
  count,
  testId,
}: {
  readonly count: number;
  readonly testId: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid={testId}>
      {Array.from({ length: count }, (_, index) => (
        <MetricCardSkeleton key={index} />
      ))}
    </div>
  );
}

/**
 * The analytics body's shape while its first read runs.
 *
 * A text line reserved almost no height, so the panel collapsed and snapped
 * back when the reading landed — the same disruption as blocking the tab
 * switch. The skeleton stands in for everything the reading becomes: the
 * metric-card row, the "Daily tokens" heading, and the chart block at its
 * full height.
 */
function AnalyticsLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-4" data-testid="stats-analytics-skeleton">
      <MetricCardsSkeleton
        count={4}
        testId="stats-analytics-skeleton-cards"
      />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-48" />
      </div>
      <Skeleton
        className="h-56 w-full rounded-lg"
        data-testid="stats-analytics-skeleton-chart"
      />
    </div>
  );
}

/**
 * The reading body's shape while its first read runs.
 *
 * Mirrors what `ReadingBody` becomes: the freshness pill, the metric cards
 * (a plan's name plus its two reported windows, the count a coding plan
 * reports), and the source line.
 */
function ReadingLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-4" data-testid="stats-reading-skeleton">
      <Skeleton
        className="h-5 w-24 rounded-full"
        data-testid="stats-reading-skeleton-pill"
      />
      <MetricCardsSkeleton
        count={3}
        testId="stats-reading-skeleton-cards"
      />
      <Skeleton
        className="h-3 w-44"
        data-testid="stats-reading-skeleton-source"
      />
    </div>
  );
}

/**
 * A token count that opens compact — millions and billions, not a digit wall.
 *
 * Hovering never switches the number; it only tints the card the chart's
 * primary colour, with the exact number in the native tooltip. Pressing pins
 * this one card to the exact form (a second press returns to compact). Each
 * card holds its own state on purpose: the user toggles one number, never the
 * whole view.
 */
function TokenCount({
  value,
  testId,
}: {
  readonly value: number | null;
  readonly testId: string;
}) {
  const [pinned, setPinned] = useState(false);

  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={pinned}
      title={formatCount(value)}
      className="cursor-pointer rounded-sm text-left text-xl font-semibold tabular text-foreground transition-colors hover:text-chart-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => setPinned((current) => !current)}
    >
      {pinned ? formatCount(value) : formatCompactCount(value)}
    </button>
  );
}

/**
 * The compact token form. Counts under a million stay grouped — there is
 * nothing to gain from "0.4M" over "412,300".
 */
function formatCompactCount(value: number | null): string {
  if (value === null) return "Not reported";
  if (value >= 1_000_000_000) {
    return `${compactNumber(value / 1_000_000_000)}B`;
  }
  if (value >= 1_000_000) {
    return `${compactNumber(value / 1_000_000)}M`;
  }
  return formatCount(value);
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * One row of the daily-tokens chart tooltip: the indicator, the series label,
 * the day's exact token count, and the compact form in brackets beside it —
 * "3,82,89,865 (38.29M)". The exact number stays first (the tooltip is the
 * hover detail); the compact is there so a big day reads at a glance.
 */
export function tokenTooltipFormatter(value: unknown): ReactElement {
  const tokens = Number(value);

  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      <div className="h-2.5 w-2.5 shrink-0 rounded-[2px] bg-(--color-tokens)" />
      <span className="text-sm text-muted-foreground">
        {activityChartConfig.tokens.label ?? "Tokens"}
      </span>
      <span className="font-mono text-sm font-medium tabular text-foreground">
        {formatCount(tokens)}
        <span className="ml-2 text-muted-foreground">
          ({formatCompactCount(tokens)})
        </span>
      </span>
    </div>
  );
}

function rollingAverageTooltipFormatter(value: unknown): ReactElement {
  const tokens = Math.round(Number(value));

  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      <div className="h-0.5 w-3 shrink-0 bg-(--color-rollingAverage)" />
      <span className="text-sm text-muted-foreground">7-day average</span>
      <span className="font-mono text-sm font-medium tabular text-foreground">
        {formatCount(tokens)} ({formatCompactCount(tokens)})
      </span>
    </div>
  );
}

function formatAbsolute(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}

function formatCount(value: number | null): string {
  return value === null
    ? "Not reported"
    : new Intl.NumberFormat().format(value);
}

function formatDays(value: number | null): string {
  return value === null
    ? "Not reported"
    : `${new Intl.NumberFormat().format(value)} days`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "Not reported";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0
    ? `${minutes}m`
    : `${minutes}m ${remainingSeconds}s`;
}

function formatDateTick(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
      }).format(date);
}

function formatDate(value: unknown): string {
  if (typeof value !== "string") return "Date unavailable";
  return formatDateTick(value);
}
