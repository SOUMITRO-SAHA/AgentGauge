/**
 * The tab row that switches which connected plan the Usage panel reads.
 *
 * Codex is always present; every other tab exists only because OpenCode
 * reports that plan as connected. A connected plan this build cannot read —
 * `integration` absent — still gets its tab, and says so, because hiding a
 * subscription the user pays for is worse than admitting it cannot be read.
 *
 * The tab set is deduplicated by integration: connecting both regional
 * variants of one vendor is one tab, not two.
 */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";

import { selectedTabAtom, selectedUsageAtom, subscriptionsAtom } from "~/atoms";
import { PanelHeader } from "~/components/dashboard/panel";
import { FreshnessPill } from "~/components/usage/provider-status-card";
import { UsageWindowList } from "~/components/usage/usage-window-row";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import type * as Ipc from "~/lib/ipc";
import {
  formatCountdown,
  formatFreshness,
  formatPlan,
  millisUntilReset,
  safeResetAt,
  toneFor,
  windowTitle,
} from "~/lib/usage";
import { cn } from "~/lib/utils";

/** One tab: the value it selects, and what it is called. */
interface Tab {
  readonly value: string;
  readonly label: string;
  /** `null` when this plan is connected but has no usage reader. */
  readonly kind: Ipc.ProviderKind | null;
}

const CODEX_TAB: Tab = { value: "codex", label: "Codex", kind: "codex" };

function tabsFrom(subscriptions: readonly Ipc.CodingSubscription[]): Tab[] {
  const tabs: Tab[] = [CODEX_TAB];
  for (const subscription of subscriptions) {
    if (subscription.integration === null) {
      tabs.push({
        value: subscription.providerId,
        label: subscription.label,
        kind: null,
      });
      continue;
    }
    if (tabs.some((tab) => tab.kind === subscription.integration)) continue;
    tabs.push({
      value: subscription.integration,
      label: subscription.label,
      kind: subscription.integration,
    });
  }
  return tabs;
}

export function UsageTabs({ nowMs }: { readonly nowMs: number }) {
  const subscriptions = useAtomValue(subscriptionsAtom);
  const selected = useAtomValue(selectedTabAtom);
  const setSelected = useAtomSet(selectedTabAtom);
  const usage = useAtomValue(selectedUsageAtom);
  const refreshUsage = useAtomRefresh(selectedUsageAtom);
  const refreshSubscriptions = useAtomRefresh(subscriptionsAtom);

  const tabs = tabsFrom(
    AsyncResult.match(subscriptions, {
      onInitial: () => [],
      onSuccess: (result) => result.value,
      onFailure: () => [],
    }),
  );

  const active = tabs.some((tab) => tab.value === selected) ? selected : "codex";

  // The tab set refreshes with the reading it belongs to: a plan connected
  // while the app was open appears on the next refresh, not on a relaunch.
  const refresh = () => {
    refreshSubscriptions();
    refreshUsage();
  };

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader
        title="Usage"
        testId="refresh-usage"
        onRefresh={refresh}
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
              data-testid={`usage-tab-${tab.value}`}
              data-active={tab.value === active}
            >
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <SelectedPlanBody
          tab={tabs.find((tab) => tab.value === active) ?? CODEX_TAB}
          usage={usage}
          nowMs={nowMs}
          onRefresh={refresh}
        />
      </Tabs>
    </div>
  );
}

/**
 * What the selected tab shows: the plan's reading, or the honest reason there
 * is not one.
 */
function SelectedPlanBody({
  tab,
  usage,
  nowMs,
  onRefresh,
}: {
  readonly tab: Tab;
  readonly usage: AsyncResult.AsyncResult<
    readonly Ipc.UsageSnapshot[],
    Ipc.AppError
  >;
  readonly nowMs: number;
  readonly onRefresh: () => void;
}) {
  if (tab.kind === null) {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="usage-plan-unreadable"
      >
        This plan is connected in OpenCode, but AgentGauge cannot read its
        usage yet.
      </p>
    );
  }

  return AsyncResult.match(usage, {
    onInitial: () => (
      <p className="text-sm text-muted-foreground" data-testid="usage-loading">
        Reading your usage…
      </p>
    ),
    onSuccess: (result) => {
      const snapshot = result.value.find(
        (item) => item.provider === tab.kind,
      );
      if (!snapshot) {
        return (
          <p className="text-sm text-muted-foreground">
            No provider reported any usage.
          </p>
        );
      }
      return <SnapshotBody snapshot={snapshot} nowMs={nowMs} />;
    },
    onFailure: (error) => (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-destructive" data-testid="usage-error">
          {failureMessage(error.cause)}
        </p>
        <button
          type="button"
          className="text-xs text-muted-foreground underline underline-offset-2"
          onClick={onRefresh}
        >
          Try again
        </button>
      </div>
    ),
  });
}

/**
 * The reason a read failed, phrased for the user.
 *
 * A protocol failure carries its own message; anything else is a defect in
 * this app's plumbing and is labelled as such rather than shown as a provider
 * problem.
 */
function failureMessage(cause: Cause.Cause<Ipc.AppError>): string {
  const squashed = Cause.squash(cause);
  if (squashed instanceof Error && squashed.message.length > 0) {
    return squashed.message;
  }
  return "The app could not be reached.";
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
        <Headline
          window={headline}
          snapshot={snapshot}
          nowMs={nowMs}
        />
      )}
      <UsageWindowList
        result={AsyncResult.success(snapshot)}
        nowMs={nowMs}
      />
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
  const freshnessLabel =
    snapshot.freshness === "unavailable"
      ? "Unavailable"
      : (formatFreshness(snapshot.fetchedAt, nowMs) ?? "Just now");

  return (
    <div className="flex flex-wrap items-center gap-2">
      <FreshnessPill freshness={snapshot.freshness} label={freshnessLabel} />
      <span className="text-xs text-muted-foreground" data-testid="plan">
        {formatPlan(snapshot.plan)}
      </span>
      {snapshot.permission === "blocked" && (
        <FreshnessPill freshness="unavailable" label="Usage blocked" />
      )}
    </div>
  );
}
