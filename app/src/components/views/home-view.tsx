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
import { useAtomValue } from "@effect/atom-react";

import { automationAtom } from "~/atoms";
import { PANEL } from "~/components/dashboard/panel";
import { ProviderStatusCard } from "~/components/usage/provider-status-card";
import { UsageTabs } from "~/components/usage/usage-tabs";
import { ViewHeader } from "~/components/views/view-header";
import { useClock } from "~/hooks/use-clock";

export function HomeView({ visible }: { readonly visible: boolean }) {
  const automation = useAtomValue(automationAtom);
  const nowMs = useClock();

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

      <MonitorGlance running={AsyncResult.match(automation, {
        onInitial: () => null,
        onSuccess: (result) => result.value.running,
        onFailure: () => null,
      })} />
    </div>
  );
}

/**
 * Whether the monitor is on, stated as a fact rather than a control.
 *
 * Set apart from the panels above it: this is context for what was just shown,
 * not another panel, so it reads as a footnote with its own rule above it rather
 * than as loose text flush against a panel's edge.
 */
function MonitorGlance({ running }: { readonly running: boolean | null }) {
  return (
    <p
      className="border-t border-border/60 pt-4 text-xs text-muted-foreground"
      data-testid="home-watcher"
    >
      {running === null
        ? "The rollover monitor could not be reached."
        : running
          ? "The rollover monitor is running."
          : "The rollover monitor is stopped."}
    </p>
  );
}
