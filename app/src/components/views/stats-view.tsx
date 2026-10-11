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
 * a fresh Radix mount; only the tab *bodies* are gated on visibility, which is
 * what keeps a hidden view from reading the account in the background.
 */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";
import { ChartBar, Fire, Lightning } from "@phosphor-icons/react";

import {
  accountUsageForAtom,
  analyticsConsentAtom,
  statsTabAtom,
  subscriptionsAtom,
  usageForAtom,
} from "~/atoms";
import { PANEL, PanelHeader } from "~/components/dashboard/panel";
import { FreshnessPill } from "~/components/usage/provider-status-card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "~/components/ui/chart";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { ViewHeader } from "~/components/views/view-header";
import * as Ipc from "~/lib/ipc";
import {
  effectiveFreshness,
  formatCountdown,
  formatFreshness,
  formatPlan,
  millisUntilReset,
  tabsFrom,
  windowTitle,
  type UsageTab,
} from "~/lib/usage";
import { useClock } from "~/hooks/use-clock";

export function StatsView({ visible }: { readonly visible: boolean }) {
  const analyticsEnabled = useAtomValue(analyticsConsentAtom);
  const setAnalyticsEnabled = useAtomSet(analyticsConsentAtom);
  const selected = useAtomValue(statsTabAtom);
  const setSelected = useAtomSet(statsTabAtom);
  const subscriptions = useAtomValue(subscriptionsAtom);

  const tabs = tabsFrom(
    AsyncResult.match(subscriptions, {
      onInitial: () => [],
      onSuccess: (result) => result.value,
      onFailure: () => [],
    }),
  );

  const active = tabs.some((tab) => tab.value === selected)
    ? selected
    : "codex";

  return (
    <div
      className={visible ? "flex flex-col gap-4" : "hidden"}
      data-testid="view-stats"
    >
      <ViewHeader
        title="Stats"
        subtitle="Local analytics across your connected plans."
      />

      <Tabs
        value={active}
        onValueChange={setSelected}
        className="flex flex-col gap-4"
      >
        <TabsList aria-label="Connected plans">
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
            {visible ? (
              <StatsTabBody
                tab={tab}
                analyticsEnabled={analyticsEnabled}
                onSetAnalytics={setAnalyticsEnabled}
              />
            ) : null}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

/** What one plan's tab shows: its stats, or the honest reason there are none. */
function StatsTabBody({
  tab,
  analyticsEnabled,
  onSetAnalytics,
}: {
  readonly tab: UsageTab;
  readonly analyticsEnabled: boolean;
  readonly onSetAnalytics: (enabled: boolean) => void;
}) {
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
    return analyticsEnabled ? (
      <div className="flex flex-col gap-4">
        <CodexActivity onDisable={() => onSetAnalytics(false)} />
        <PlanReading kind={tab.kind} label={tab.label} />
      </div>
    ) : (
      <AnalyticsOff onEnable={() => onSetAnalytics(true)} />
    );
  }

  if (TOKEN_HISTORY_PROVIDERS.includes(tab.kind)) {
    return analyticsEnabled ? (
      <div className="flex flex-col gap-4">
        <PlanAnalytics kind={tab.kind} label={tab.label} />
        <PlanReading kind={tab.kind} label={tab.label} />
      </div>
    ) : (
      <AnalyticsOff onEnable={() => onSetAnalytics(true)} />
    );
  }

  return <PlanReading kind={tab.kind} label={tab.label} />;
}

/**
 * The providers whose backend reports token history, so a stats tab can carry
 * the same activity analytics Codex's does. Anything absent keeps reading its
 * windows only, and a provider added here must implement the account-usage
 * read in Rust — the card is a promise the read has to keep.
 */
const TOKEN_HISTORY_PROVIDERS: readonly Ipc.ProviderKind[] = ["codex", "zai"];

/**
 * The state a user's own opt-out produces.
 *
 * Deliberately smaller than the old consent gate: this is a preference turned
 * off, and the way back is one button.
 */
function AnalyticsOff({ onEnable }: { readonly onEnable: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enable = async () => {
    setSaving(true);
    setError(null);
    try {
      await Effect.runPromise(Ipc.setAnalyticsConsent(true));
      onEnable();
    } catch {
      setError("Your analytics preference could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className={`${PANEL} flex flex-col gap-3`}
      data-testid="stats-analytics-off"
    >
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-accent-glass p-2 text-brand-teal">
          <ChartBar aria-hidden="true" className="size-5" />
        </div>
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-base font-semibold text-foreground">
            Local analytics is off
          </h2>
          <p className="text-sm text-muted-foreground">
            Codex token activity stays unread until you turn local analytics
            back on. Your other plans' readings are not affected.
          </p>
        </div>
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button
        type="button"
        className="self-start"
        disabled={saving}
        onClick={() => void enable()}
        data-testid="stats-enable-analytics"
      >
        {saving ? "Saving…" : "Turn back on"}
      </Button>
    </section>
  );
}

/** The Codex tab: token activity, with the opt-out at the bottom. */
function CodexActivity({ onDisable }: { readonly onDisable: () => void }) {
  const usage = useAtomValue(accountUsageForAtom("codex"));
  const refresh = useAtomRefresh(accountUsageForAtom("codex"));
  const [saving, setSaving] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const disable = async () => {
    setSaving(true);
    setRevokeError(null);
    try {
      await Effect.runPromise(Ipc.setAnalyticsConsent(false));
      onDisable();
    } catch {
      setRevokeError(
        "Your analytics permission could not be turned off. Try again.",
      );
    } finally {
      setSaving(false);
    }
  };

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
        onInitial: () => (
          <p
            className="text-sm text-muted-foreground"
            data-testid="stats-analytics-loading"
          >
            Reading Codex activity…
          </p>
        ),
        onSuccess: (result) => (
          <AnalyticsContent usage={result.value} refreshing={result.waiting} />
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
        {revokeError ? (
          <p className="text-sm text-destructive" role="alert">
            {revokeError}
          </p>
        ) : null}
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
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={saving}
          onClick={() => void disable()}
          data-testid="stats-disable-analytics"
        >
          {saving ? "Saving…" : "Turn off analytics"}
        </Button>
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
        onInitial: () => (
          <p
            className="text-sm text-muted-foreground"
            data-testid="stats-plan-analytics-loading"
          >
            Reading {label} activity…
          </p>
        ),
        onSuccess: (result) => (
          <AnalyticsContent usage={result.value} refreshing={result.waiting} />
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
        onInitial: () => (
          <div
            className="flex flex-col gap-3"
            data-testid="stats-reading-skeleton"
          >
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-20 w-full rounded-lg" />
          </div>
        ),
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

const activityChartConfig = {
  tokens: { label: "Tokens", color: "var(--chart-1)" },
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
  const chartData = buckets.map((bucket) => ({
    date: bucket.startDate,
    tokens: bucket.tokens,
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
          <BarChart
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
                />
              }
            />
            <Bar
              dataKey="tokens"
              fill="var(--color-tokens)"
              radius={4}
              maxBarSize={28}
            />
          </BarChart>
        </ChartContainer>
      )}
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
 * A token count that opens compact — millions and billions, not a digit wall.
 *
 * Hovering previews the exact number, and clicking pins this one card to the
 * exact form (a second click returns to compact). Each card holds its own
 * state on purpose: the user toggles one number, never the whole view.
 */
function TokenCount({
  value,
  testId,
}: {
  readonly value: number | null;
  readonly testId: string;
}) {
  const [pinned, setPinned] = useState(false);
  const [hovering, setHovering] = useState(false);

  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={pinned}
      title={formatCount(value)}
      className="cursor-pointer rounded-sm text-left text-xl font-semibold tabular text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onClick={() => setPinned((current) => !current)}
    >
      {pinned || hovering ? formatCount(value) : formatCompactCount(value)}
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
