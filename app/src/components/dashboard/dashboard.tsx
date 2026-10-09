/**
 * The main dashboard.
 *
 * Responsive by default: the same markup serves a 300px-wide widget window and
 * a wide desktop window. Two rules make that work:
 *
 *  - space is expressed in `clamp()` so padding and type scale with the
 *    viewport rather than jumping at a breakpoint, and
 *  - the panels stack on their own grid track, so nothing needs a `md:` variant
 *    to avoid overflowing.
 */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Effect from "effect/Effect";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { LayoutPanelTop, Play, RefreshCw, Square } from "lucide-react";

import { automationAtom, usageAtom, widgetAtom } from "~/atoms";
import { Button } from "~/components/ui/button";
import {
  FreshnessPill,
  ProviderStatusCard,
} from "~/components/usage/provider-status-card";
import { UsageWindowList } from "~/components/usage/usage-window-row";
import { useClock } from "~/hooks/use-clock";
import * as Ipc from "~/lib/ipc";
import { formatFreshness, formatPlan } from "~/lib/usage";

/** Shared shell: fluid gutter and vertical rhythm, no fixed width. */
const PAGE = "mx-auto flex w-full flex-col gap-[clamp(0.75rem,2.5vw,1.5rem)] px-[clamp(0.75rem,4vw,2rem)] py-[clamp(1rem,4vw,2rem)]";

/** Every panel shares one shape so they stack cleanly at any width. */
const PANEL = "rounded-xl border border-border/70 bg-surface-raised/70 p-[clamp(0.75rem,2.5vw,1.25rem)] backdrop-blur-md";

export function Dashboard({ hidden = false }: { readonly hidden?: boolean }) {
  const usage = useAtomValue(usageAtom);
  const automation = useAtomValue(automationAtom);
  const widget = useAtomValue(widgetAtom);
  const refreshUsage = useAtomRefresh(usageAtom);
  const refreshAutomation = useAtomRefresh(automationAtom);
  const refreshWidget = useAtomRefresh(widgetAtom);
  const nowMs = useClock();

  return (
    // Stays mounted while the onboarding flow is showing, so its atoms are warm
    // the moment the flow closes. A `display` wrapper hides it — `hidden` alone
    // would leave the panels laid out but zero-sized, and a spec asserting on a
    // child would read a stale node instead of a visible one.
    <div
      className={hidden ? "hidden" : "block"}
      data-testid="dashboard-shell"
      aria-hidden={hidden}
    >
      <main className={PAGE} data-testid="dashboard">
      <header className="flex flex-col gap-1">
        <h1 className="text-[clamp(1.25rem,4vw,1.5rem)] font-semibold tracking-tight text-foreground">
          AI Sub Stats
        </h1>
        <p className="text-sm text-muted-foreground">
          Your Codex window, read from your own CLI.
        </p>
      </header>

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

            return (
              <div className="flex flex-col gap-4">
                <SnapshotHeader snapshot={codex} nowMs={nowMs} />
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

      <section className={PANEL} data-testid="automation-panel">
        <PanelHeader
          title="Window watcher"
          testId="refresh-automation"
          onRefresh={refreshAutomation}
        />

        {AsyncResult.match(automation, {
          onInitial: () => (
            <p className="text-sm text-muted-foreground">Checking the watcher…</p>
          ),
          onSuccess: (result) => {
            const state = result.value;
            return (
              // Wraps rather than truncates: the toggle must stay reachable
              // when the panel is only a few hundred pixels wide.
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span
                  className="text-sm text-foreground"
                  data-testid="automation-status"
                >
                  {state.running ? "Running" : "Stopped"}
                </span>
                <AutomationToggle
                  running={state.running}
                  onStart={() => {
                    void Effect.runPromise(Ipc.startAutomation()).then(
                      refreshAutomation,
                    );
                  }}
                  onStop={() => {
                    void Effect.runPromise(Ipc.stopAutomation()).then(
                      refreshAutomation,
                    );
                  }}
                />
              </div>
            );
          },
          onFailure: () => (
            <p className="text-sm text-destructive">
              The app could not be reached.
            </p>
          ),
        })}
      </section>

      <section className={PANEL} data-testid="widget-panel">
        <PanelHeader
          title="Desktop widget"
          testId="refresh-widget"
          onRefresh={refreshWidget}
        />

        {AsyncResult.match(widget, {
          onInitial: () => (
            <p className="text-sm text-muted-foreground">Checking the widget…</p>
          ),
          onSuccess: (result) => {
            const status = result.value;
            return (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span
                  className="text-sm text-foreground"
                  data-testid="widget-status"
                >
                  {status.installed
                    ? "Set up and always on top"
                    : (status.reason ?? "Not set up")}
                </span>
                <Button
                  variant={status.installed ? "outline" : "default"}
                  size="sm"
                  className="shrink-0"
                  onClick={() => {
                    const next = status.installed
                      ? Ipc.hideWidget()
                      : Ipc.setupWidget();
                    void Effect.runPromise(next).then(refreshWidget);
                  }}
                  data-testid="widget-toggle"
                >
                  <LayoutPanelTop aria-hidden="true" />
                  {status.installed ? "Remove" : "Set up widget"}
                </Button>
              </div>
            );
          },
          onFailure: () => (
            <p className="text-sm text-destructive">
              The app could not be reached.
            </p>
          ),
        })}
      </section>
    </main>
    </div>
  );
}

/**
 * A panel title with a refresh action.
 *
 * The title truncates rather than wrapping, so the action stays on one line at
 * narrow widths instead of pushing itself off-screen.
 */
function PanelHeader({
  title,
  testId,
  onRefresh,
}: {
  readonly title: string;
  readonly testId: string;
  readonly onRefresh: () => void;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-2">
      <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0"
        onClick={onRefresh}
        data-testid={testId}
      >
        <RefreshCw aria-hidden="true" />
        <span className="hidden sm:inline">Refresh</span>
      </Button>
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

function AutomationToggle({
  running,
  onStart,
  onStop,
}: {
  readonly running: boolean;
  readonly onStart: () => void;
  readonly onStop: () => void;
}) {
  return (
    <Button
      variant={running ? "outline" : "default"}
      size="sm"
      className="shrink-0"
      onClick={running ? onStop : onStart}
      data-testid="automation-toggle"
    >
      {running ? (
        <>
          <Square aria-hidden="true" />
          Stop
        </>
      ) : (
        <>
          <Play aria-hidden="true" />
          Start
        </>
      )}
    </Button>
  );
}