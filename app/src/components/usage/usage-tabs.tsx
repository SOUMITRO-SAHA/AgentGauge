/**
 * The tab row that switches which connected plan the Usage panel reads.
 *
 * Codex is always present; every other tab exists only because OpenCode
 * reports that plan as connected. A connected plan this build cannot read —
 * `integration` absent — still gets its tab, and says so, because hiding a
 * subscription the user pays for is worse than admitting it cannot be read.
 *
 * Switching is never blocked by a read: each provider's reading lives in its
 * own session-retained atom, so a revisit renders immediately while a fresh
 * read runs underneath, and only a provider seen for the first time shows the
 * skeleton. The tab set is deduplicated by integration, so connecting both
 * regional variants of one vendor is one tab, not two.
 */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import { useEffect, useRef } from "react";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";

import { selectedTabAtom, subscriptionsAtom, usageForAtom } from "~/atoms";
import { PanelHeader } from "~/components/dashboard/panel";
import { FreshnessPill } from "~/components/usage/provider-status-card";
import {
  UsageWindowList,
  UsageWindowSkeleton,
} from "~/components/usage/usage-window-row";
import { Skeleton } from "~/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import type * as Ipc from "~/lib/ipc";
import { failureReason } from "~/lib/ipc";
import {
  effectiveFreshness,
  formatCountdown,
  formatFreshness,
  formatPlan,
  millisUntilReset,
  safeResetAt,
  tabsFrom,
  toneFor,
  windowTitle,
  type UsageTab,
} from "~/lib/usage";
import { cn } from "~/lib/utils";

export function UsageTabs({ nowMs }: { readonly nowMs: number }) {
  const subscriptions = useAtomValue(subscriptionsAtom);
  const selected = useAtomValue(selectedTabAtom);
  const setSelected = useAtomSet(selectedTabAtom);
  const refreshSubscriptions = useAtomRefresh(subscriptionsAtom);

  // Only the active tab's body is mounted, so it is the one that registers
  // its refresher here — the header's Refresh button then re-reads exactly
  // what is on screen, plus the tab set itself.
  const refreshers = useRef(new Map<string, () => void>());

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

  // The tab set refreshes with the reading it belongs to: a plan connected
  // while the app was open appears on the next refresh, not on a relaunch.
  const refresh = () => {
    refreshSubscriptions();
    refreshers.current.get(active)?.();
  };

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader title="Usage" testId="refresh-usage" onRefresh={refresh} />
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
              data-testid={`usage-tab-${tab.value}`}
              data-active={tab.value === active}
            >
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {tabs.map((tab) => (
          <TabsContent
            key={tab.value}
            value={tab.value}
            className="animate-in fade-in duration-200"
          >
            <PlanTabBody tab={tab} nowMs={nowMs} refreshers={refreshers} />
          </TabsContent>
        ))}
      </Tabs>

      <SubscriptionsNotice subscriptions={subscriptions} onRefresh={refresh} />
    </div>
  );
}

/**
 * The state between "no other plan is connected" and "we could not ask".
 *
 * An empty successful list is a real answer and renders nothing extra. A
 * failed read must not collapse to a Codex-only panel as though the user had
 * nothing connected — that is exactly how a connected plan silently
 * disappears.
 */
function SubscriptionsNotice({
  subscriptions,
  onRefresh,
}: {
  readonly subscriptions: AsyncResult.AsyncResult<
    readonly Ipc.CodingSubscription[],
    Ipc.AppError
  >;
  readonly onRefresh: () => void;
}) {
  return AsyncResult.match(subscriptions, {
    onInitial: () => null,
    onSuccess: () => null,
    onFailure: () => (
      <p
        className="text-xs text-muted-foreground"
        data-testid="subscriptions-unavailable"
      >
        OpenCode could not be asked which plans are connected, so only Codex is
        shown.{" "}
        <button
          type="button"
          className="underline underline-offset-2"
          onClick={onRefresh}
        >
          Try again
        </button>
      </p>
    ),
  });
}

/** What one plan's tab shows: its reading, or the honest reason there is none. */
function PlanTabBody({
  tab,
  nowMs,
  refreshers,
}: {
  readonly tab: UsageTab;
  readonly nowMs: number;
  readonly refreshers: React.RefObject<Map<string, () => void>>;
}) {
  if (tab.kind === null) {
    // Nothing of this tab's own to re-read: whether a reader exists is a
    // property of the build, and the header's refresh re-asks OpenCode.
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="usage-plan-unreadable"
      >
        This plan is connected in OpenCode, but AgentGauge cannot read its usage
        yet.
      </p>
    );
  }

  return (
    <ProviderUsage
      kind={tab.kind}
      value={tab.value}
      nowMs={nowMs}
      refreshers={refreshers}
    />
  );
}

/**
 * Registers the mounted tab's refresher under its own value.
 *
 * The register/unregister pair lives in an effect keyed by the ref object and
 * the value — both stable for a tab's lifetime — so re-renders never touch the
 * map. The refresher itself is read through a ref so a fresh identity does not
 * re-run the effect either.
 */
function useRefRegister(
  refreshers: React.RefObject<Map<string, () => void>>,
  value: string,
  refresh: () => void,
) {
  const invoker = useRef(refresh);
  invoker.current = refresh;
  useEffect(() => {
    const map = refreshers.current;
    if (map === null) return;
    map.set(value, () => invoker.current());
    return () => {
      map.delete(value);
    };
  }, [refreshers, value]);
}

/** One provider's reading, in the states a reading can be in. */
function ProviderUsage({
  kind,
  value,
  nowMs,
  refreshers,
}: {
  readonly kind: Ipc.ProviderKind;
  readonly value: string;
  readonly nowMs: number;
  readonly refreshers: React.RefObject<Map<string, () => void>>;
}) {
  const usage = useAtomValue(usageForAtom(kind));
  const refreshOwn = useAtomRefresh(usageForAtom(kind));

  useRefRegister(refreshers, value, refreshOwn);

  return AsyncResult.match(usage, {
    onInitial: () => <UsageLoadingSkeleton />,
    onSuccess: (result) => {
      const snapshot = result.value.find((item) => item.provider === kind);
      if (!snapshot) {
        return (
          <p className="text-sm text-muted-foreground">
            No provider reported any usage.
          </p>
        );
      }
      return (
        <div className="flex flex-col gap-4">
          <SnapshotBody snapshot={snapshot} nowMs={nowMs} />
        </div>
      );
    },
    onFailure: (error) => (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-destructive" data-testid="usage-error">
          {failureMessage(error.cause)}
        </p>
        <button
          type="button"
          className="text-xs text-muted-foreground underline underline-offset-2"
          onClick={refreshOwn}
        >
          Try again
        </button>
      </div>
    ),
  });
}

/**
 * The shape of a reading while it is being read.
 *
 * This stands in for the whole panel — status row, headline, and one row per
 * window — not a placeholder line. A skeleton shorter than the reading it
 * becomes makes the container collapse and then snap back when the data lands,
 * which is the same visual disruption as blocking the switch. The window count
 * mirrors the two windows a coding plan reports (its rolling window and its
 * weekly cap); a provider reporting a different count is corrected the instant
 * its reading arrives.
 */
function UsageLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-4" data-testid="usage-skeleton">
      <div
        className="flex flex-wrap items-center gap-2"
        data-testid="usage-skeleton-status"
      >
        <Skeleton className="h-5 w-20 rounded-full" />
        <Skeleton className="h-4 w-14" />
      </div>
      <div
        className="flex flex-col gap-2"
        data-testid="usage-skeleton-headline"
      >
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-10 w-32" />
        <Skeleton className="h-4 w-52" />
      </div>
      <div className="flex flex-col gap-5">
        <UsageWindowSkeleton />
        <UsageWindowSkeleton />
      </div>
    </div>
  );
}

/** The reading itself: freshness, the one big number, every window. */
function SnapshotBody({
  snapshot,
  nowMs,
}: {
  readonly snapshot: Ipc.UsageSnapshot;
  readonly nowMs: number;
}) {
  const headline =
    snapshot.fiveHour ??
    [...snapshot.windows].sort(
      (a, b) =>
        (safeResetAt(a.resetsAt) ?? Number.POSITIVE_INFINITY) -
        (safeResetAt(b.resetsAt) ?? Number.POSITIVE_INFINITY),
    )[0];

  return (
    <div className="flex flex-col gap-4">
      <SnapshotHeader snapshot={snapshot} nowMs={nowMs} />
      {headline && (
        <Headline window={headline} snapshot={snapshot} nowMs={nowMs} />
      )}
      <UsageWindowList result={AsyncResult.success(snapshot)} nowMs={nowMs} />
    </div>
  );
}

const TONE_TEXT = {
  healthy: "text-ok",
  warning: "text-warn",
  critical: "text-critical",
  unknown: "text-muted-foreground",
} as const;

/** The one number that answers "can I keep working". */
function Headline({
  window: usageWindow,
  snapshot,
  nowMs,
}: {
  readonly window: Ipc.UsageWindow;
  readonly snapshot: Ipc.UsageSnapshot;
  readonly nowMs: number;
}) {
  const tone = toneFor({
    usedPercent: usageWindow.usedPercent,
    freshness: snapshot.freshness,
    permission: snapshot.permission,
  });

  return (
    <div className="flex flex-col gap-1" data-testid="home-window">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {windowTitle(usageWindow.label, usageWindow.durationMins)}
      </p>
      <p
        className={cn(
          "text-[clamp(2.5rem,8vw,3.5rem)] font-semibold leading-none tabular",
          TONE_TEXT[tone],
        )}
        data-testid="home-remaining"
      >
        {usageWindow.remainingPercent}
        <span className="text-[0.5em] text-muted-foreground">%</span>
      </p>
      <p className="text-sm text-muted-foreground">
        remaining · resets in{" "}
        <span className="tabular" data-testid="home-window-reset">
          {formatCountdown(millisUntilReset(usageWindow.resetsAt, nowMs)) ??
            "—"}
        </span>
      </p>
    </div>
  );
}

function SnapshotHeader({
  snapshot,
  nowMs,
}: {
  readonly snapshot: Ipc.UsageSnapshot;
  readonly nowMs: number;
}) {
  const freshness = effectiveFreshness(snapshot, nowMs);
  const freshnessLabel =
    freshness === "unavailable"
      ? "Unavailable"
      : (formatFreshness(snapshot.fetchedAt, nowMs) ?? "Just now");

  return (
    <div className="flex flex-wrap items-center gap-2">
      <FreshnessPill freshness={freshness} label={freshnessLabel} />
      <span className="text-xs text-muted-foreground" data-testid="plan">
        {formatPlan(snapshot.plan)}
      </span>
      {snapshot.permission === "blocked" && (
        <FreshnessPill freshness="unavailable" label="Usage blocked" />
      )}
    </div>
  );
}

/**
 * The reason a read failed, phrased for the user.
 *
 * A protocol failure carries its own message; anything else is a defect in
 * this app's plumbing and is labelled as such rather than shown as a provider
 * problem.
 */
function failureMessage(cause: Cause.Cause<Ipc.AppError>): string {
  return failureReason(cause) ?? "The app could not be reached.";
}
