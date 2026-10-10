/**
 * Home: whether the window is usable right now.
 *
 * The answer view. Provider availability, the one number that matters — how
 * much of the soonest-expiring window remains — and whether the watcher is on.
 * The soonest window is chosen by reset time, not by matching a label: the
 * label vocabulary belongs to the provider, and a rename would otherwise
 * silently promote the wrong window to the headline.
 *
 * Owns every testid the dashboard historically had on the default route
 * (`usage-panel`, `refresh-usage`, `plan`, `freshness-pill`, `window-bar`), so
 * the existing specs keep reading this view without navigating.
 */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";

import { automationAtom, usageAtom } from "~/atoms";
import { PANEL, PanelHeader } from "~/components/dashboard/panel";
import {
  FreshnessPill,
  ProviderStatusCard,
} from "~/components/usage/provider-status-card";
import { UsageWindowList } from "~/components/usage/usage-window-row";
import { ViewHeader } from "~/components/views/view-header";
import { useClock } from "~/hooks/use-clock";
import type * as Ipc from "~/lib/ipc";
import {
  formatCountdown,
  formatFreshness,
  formatPlan,
  millisUntilReset,
  safeResetAt,
  toneFor,
  windowTitle,
  type Tone,
} from "~/lib/usage";

const TONE_TEXT: Record<Tone, string> = {
  healthy: "text-ok",
  warning: "text-warn",
  critical: "text-critical",
  unknown: "text-muted-foreground",
};

export function HomeView({ visible }: { readonly visible: boolean }) {
  const usage = useAtomValue(usageAtom);
  const automation = useAtomValue(automationAtom);
  const refreshUsage = useAtomRefresh(usageAtom);
  const nowMs = useClock();

  return (
    <div className={visible ? "block" : "hidden"} data-testid="view-home">
      <ViewHeader
        title="Home"
        subtitle="Your Codex window, read from your own CLI."
      />

      <ProviderStatusCard />

      <section className={PANEL} data-testid="usage-panel">
        <PanelHeader
          title="Usage"
          testId="refresh-usage"
          onRefresh={refreshUsage}
        />

        {AsyncResult.match(usage, {
          onInitial: () => (
            <p
              className="text-sm text-muted-foreground"
              data-testid="usage-loading"
            >
              Reading your usage…
            </p>
          ),
          onSuccess: (result) => {
            const codex = result.value.find(
              (snapshot) => snapshot.provider === "codex",
            );
            if (!codex) {
              return (
                <p className="text-sm text-muted-foreground">
                  No provider reported any usage.
                </p>
              );
            }

            // The Rust side carries the windows as explicit kinds — `fiveHour`
            // and `weekly` — so the headline never pattern-matches a label.
            // The soonest-resetting window is the fallback for a provider that
            // reported windows but neither named kind; a window with no reset
            // time sorts last.
            const headline =
              codex.fiveHour ??
              [...codex.windows].sort(
                (a, b) =>
                  (safeResetAt(a.resetsAt) ?? Number.POSITIVE_INFINITY) -
                  (safeResetAt(b.resetsAt) ?? Number.POSITIVE_INFINITY),
              )[0];

            return (
              <div className="flex flex-col gap-4">
                <SnapshotHeader snapshot={codex} nowMs={nowMs} />
                {headline && (
                  <Headline
                    window={headline}
                    snapshot={codex}
                    nowMs={nowMs}
                  />
                )}
                <UsageWindowList
                  result={AsyncResult.success(codex)}
                  nowMs={nowMs}
                />
              </div>
            );
          },
          onFailure: () => (
            <p className="text-sm text-destructive" data-testid="usage-error">
              The app could not be reached.
            </p>
          ),
        })}
      </section>

      <WatcherGlance running={AsyncResult.match(automation, {
        onInitial: () => null,
        onSuccess: (result) => result.value.running,
        onFailure: () => null,
      })} />
    </div>
  );
}

/** The one number that answers "can I keep working". */
function Headline({
  window,
  snapshot,
  nowMs,
}: {
  readonly window: Ipc.UsageWindow;
  readonly snapshot: Ipc.UsageSnapshot;
  readonly nowMs: number;
}) {
  // Same tone rule as every row: an unavailable reading is unknown, never a
  // confident colour, and the snapshot's own permission decides the rest.
  const tone = toneFor({
    usedPercent: window.usedPercent,
    freshness: snapshot.freshness,
    permission: snapshot.permission,
  });

  return (
    <div className="flex flex-col gap-1" data-testid="home-window">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {windowTitle(window.label, window.durationMins)}
      </p>
      <p
        className={`text-[clamp(2.5rem,8vw,3.5rem)] font-semibold leading-none tabular ${TONE_TEXT[tone]}`}
        data-testid="home-remaining"
      >
        {window.remainingPercent}
        <span className="text-[0.5em] text-muted-foreground">%</span>
      </p>
      <p className="text-sm text-muted-foreground">
        remaining · resets in{" "}
        <span className="tabular" data-testid="home-window-reset">
          {formatCountdown(millisUntilReset(window.resetsAt, nowMs)) ?? "—"}
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

/**
 * Whether the watcher is on, stated as a fact rather than a control.
 *
 * Set apart from the panels above it: this is context for what was just shown,
 * not another panel, so it reads as a footnote with its own rule above it rather
 * than as loose text flush against a panel's edge.
 */
function WatcherGlance({ running }: { readonly running: boolean | null }) {
  return (
    <p
      className="border-t border-border/60 pt-4 text-xs text-muted-foreground"
      data-testid="home-watcher"
    >
      {running === null
        ? "The window watcher could not be reached."
        : running
          ? "The window watcher is running."
          : "The window watcher is stopped."}
    </p>
  );
}
