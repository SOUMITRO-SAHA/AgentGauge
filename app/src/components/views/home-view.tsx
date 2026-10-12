/**
 * Home: whether the window is usable right now.
 *
 * The answer view. Provider availability, the one number that matters — how
 * much of the soonest-expiring window remains — and whether the monitor is on.
 * The soonest window is chosen by reset time, not by matching a label: the
 * label vocabulary belongs to the provider, and a rename would otherwise
 * silently promote the wrong window to the headline.
 *
 * Owns every testid the dashboard historically had on the default route
 * (`usage-panel`, `refresh-usage`, `plan`, `freshness-pill`, `window-bar`), so
 * the existing specs keep reading this view without navigating.
 */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useEffect } from "react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";

import { automationAtom } from "~/atoms";
import { PANEL } from "~/components/dashboard/panel";
import { Skeleton } from "~/components/ui/skeleton";
import { ProviderStatusCard } from "~/components/usage/provider-status-card";
import { UsageTabs } from "~/components/usage/usage-tabs";
import { ViewHeader } from "~/components/views/view-header";
import { useClock } from "~/hooks/use-clock";
import type * as Ipc from "~/lib/ipc";

export function HomeView({ visible }: { readonly visible: boolean }) {
  const automation = useAtomValue(automationAtom);
  const refreshAutomation = useAtomRefresh(automationAtom);
  const nowMs = useClock();

  // The glance re-reads whenever Home becomes visible, so the monitor counts
  // reflect the persisted choices as they are now, not as they were at mount.
  useEffect(() => {
    if (visible) {
      refreshAutomation();
    }
  }, [visible, refreshAutomation]);

  return (
    <div className={visible ? "flex flex-col gap-4" : "hidden"} data-testid="view-home">
      <ViewHeader
        title="Home"
        subtitle="Your coding plans, read from your own tools."
      />

      <ProviderStatusCard />

      <section className={PANEL} data-testid="usage-panel">
        <UsageTabs nowMs={nowMs} />
      </section>

      <MonitorGlance
        result={automation}
      />
    </div>
  );
}

/**
 * How many of the per-sub rollover monitors are on, stated as a fact rather
 * than a control. Set apart from the panels above it: this is context for what
 * was just shown, not another panel.
 */
function MonitorGlance({
  result,
}: {
  readonly result: AsyncResult.AsyncResult<
    readonly Ipc.AutomationState[],
    Ipc.AppError
  >;
}) {
  return (
    <div className="border-t border-border/60 pt-4">
      {AsyncResult.match(result, {
        onInitial: () => (
          <div
            className="flex items-center"
            data-testid="home-watcher-loading"
            role="status"
            aria-label="Loading rollover monitor status"
          >
            <Skeleton className="h-3 w-48" aria-hidden="true" />
          </div>
        ),
        onFailure: () => (
          <p className="text-xs text-muted-foreground" data-testid="home-watcher">
            The rollover monitor status is unavailable.
          </p>
        ),
        onSuccess: (result) => {
          const running = result.value.filter(
            (monitor) => monitor.running,
          ).length;
          return (
            <p
              className="text-xs text-muted-foreground"
              data-testid="home-watcher"
            >
              {running === 0
                ? "No rollover monitors are running."
                : running === 1
                  ? "1 rollover monitor is running."
                  : `${running} rollover monitors are running.`}
            </p>
          );
        },
      })}
    </div>
  );
}
