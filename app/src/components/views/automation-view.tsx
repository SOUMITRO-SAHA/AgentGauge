/**
 * Automation: one rollover monitor per connected sub.
 *
 * Every sub the app can read — Codex always, plus every OpenCode-connected
 * plan — gets its own card with its own start/stop, its own rollover rows, and
 * its own check schedule. Starting a monitor is a *choice*: the backend
 * persists it and resumes it on the next launch, so a sub that is running was
 * running before this screen ever opened, and the button says Stop.
 *
 * Each monitor's one job is to *detect* the moment its sub's window rolls
 * over — never to cause one. That boundary is stated in the copy here, not
 * just implemented in Rust, because it is the single most misunderstood thing
 * about the feature: a 5-hour window cannot be restarted by a prompt, and
 * sending a prompt spends the account's quota rather than opening a new
 * window.
 */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Effect from "effect/Effect";
import { useEffect, type ReactElement } from "react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Play, Stop } from "@phosphor-icons/react";

import { automationAtom, subscriptionsAtom } from "~/atoms";
import { Button } from "~/components/ui/button";
import { ViewHeader } from "~/components/views/view-header";
import { PANEL, PanelHeader } from "~/components/dashboard/panel";
import * as Ipc from "~/lib/ipc";
import { tabsFrom, type UsageTab } from "~/lib/usage";

export function AutomationView({ visible }: { readonly visible: boolean }) {
  const automation = useAtomValue(automationAtom);
  const refreshAutomation = useAtomRefresh(automationAtom);
  const subscriptions = useAtomValue(subscriptionsAtom);

  // Opening the screen re-reads: the retained answer paints instantly, and
  // the current monitor states land underneath — monitor state is exactly the
  // thing that changes while the app was looking elsewhere.
  useEffect(() => {
    if (visible) {
      refreshAutomation();
    }
  }, [visible, refreshAutomation]);

  // The same tab set the Usage panel renders: Codex always, every connected
  // plan beside it. A connected plan this build cannot read has no reader to
  // watch, so it has no monitor card either.
  const tabs = tabsFrom(
    AsyncResult.match(subscriptions, {
      onInitial: () => [],
      onSuccess: (result) => result.value,
      onFailure: () => [],
    }),
  ).filter((tab): tab is UsageTab & { kind: NonNullable<UsageTab["kind"]> } =>
    tab.kind !== null,
  );

  return (
    <div
      className={visible ? "flex flex-col gap-4" : "hidden"}
      data-testid="view-automation"
    >
      <ViewHeader
        title="Automation"
        subtitle="Every connected sub gets its own rollover monitor."
      />

      {AsyncResult.match(automation, {
        onInitial: () => (
          <section className={PANEL} data-testid="automation-loading">
            <p className="text-sm text-muted-foreground">
              Checking the monitors…
            </p>
          </section>
        ),
        onFailure: () => (
          <p className="text-sm text-destructive" data-testid="automation-error">
            The app could not be reached.
          </p>
        ),
        onSuccess: (result) =>
          tabs.map((tab) => (
            <MonitorCard
              key={tab.value}
              tab={tab}
              monitor={
                result.value.find((monitor) => monitor.kind === tab.kind) ??
                null
              }
              onChanged={refreshAutomation}
            />
          )),
      })}

      <p className="text-xs leading-relaxed text-muted-foreground">
        The monitors only read. A 5-hour window cannot be restarted by a prompt
        — sending one consumes the current window, so nothing is ever sent: a
        rollover is detected, never caused. Starting a monitor is remembered,
        so it runs again the next time AgentGauge opens.
      </p>
    </div>
  );
}

function MonitorCard({
  tab,
  monitor,
  onChanged,
}: {
  readonly tab: UsageTab & { kind: NonNullable<UsageTab["kind"]> };
  readonly monitor: Ipc.AutomationState | null;
  readonly onChanged: () => void;
}): ReactElement {
  const kind = tab.kind;
  const running = monitor?.running ?? false;

  return (
    <section className={PANEL} data-testid={`automation-panel-${kind}`}>
      <PanelHeader
        title={`${tab.label} · Rollover monitor`}
        testId={`refresh-automation-${kind}`}
        onRefresh={onChanged}
      />

      {monitor === null ? (
        <p className="text-sm text-muted-foreground">
          Checking the monitor…
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span
              className="text-sm text-foreground"
              data-testid={`automation-status-${kind}`}
            >
              {running ? "Running" : "Stopped"}
            </span>
            <AutomationToggle
              kind={kind}
              running={running}
              onStart={() => {
                void Effect.runPromise(Ipc.startAutomation(kind)).then(
                  onChanged,
                );
              }}
              onStop={() => {
                void Effect.runPromise(Ipc.stopAutomation(kind)).then(
                  onChanged,
                );
              }}
            />
          </div>

          <RolloverDetails kind={kind} monitor={monitor} onChanged={onChanged} />
          <WatchSchedule kind={kind} monitor={monitor} />
        </div>
      )}
    </section>
  );
}

/**
 * Rollover facts: the reset the source last reported, and the transition the
 * monitor detected. The PRD separates a *reported* reset from an *observed*
 * rollover, so the labels must too.
 */
function RolloverDetails({
  kind,
  monitor,
  onChanged,
}: {
  readonly kind: Ipc.ProviderKind;
  readonly monitor: Ipc.AutomationState;
  readonly onChanged: () => void;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid={`automation-rollover-${kind}`}>
      <DetailGroupLabel>Rollover</DetailGroupLabel>
      <DetailRow
        testId={`automation-observed-reset-${kind}`}
        label="Last reported reset"
        value={formatTime(monitor.observedResetsAt)}
      />
      <DetailRow
        testId={`automation-rolled-over-at-${kind}`}
        label="Rollover detected at"
        value={formatTime(monitor.rolledOverAt)}
      />

      {monitor.rolledOver && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span
            className="text-sm text-warn"
            data-testid={`automation-rolled-over-${kind}`}
          >
            A fresh window was detected.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void Effect.runPromise(Ipc.acknowledgeRollover(kind)).then(
                onChanged,
              );
            }}
            data-testid={`automation-acknowledge-${kind}`}
          >
            Acknowledge
          </Button>
        </div>
      )}
    </div>
  );
}

function WatchSchedule({
  kind,
  monitor,
}: {
  readonly kind: Ipc.ProviderKind;
  readonly monitor: Ipc.AutomationState;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid={`automation-schedule-${kind}`}>
      <DetailGroupLabel>Checks</DetailGroupLabel>
      <DetailRow
        testId={`automation-last-polled-${kind}`}
        label="Last checked"
        value={formatTime(monitor.lastPolledAt)}
      />
      <DetailRow
        testId={`automation-next-poll-${kind}`}
        label="Next check"
        value={formatTime(monitor.nextPollAt)}
      />
    </div>
  );
}

/** The quiet heading that frames a group of detail rows. */
function DetailGroupLabel({ children }: { readonly children: React.ReactNode }) {
  return (
    <span className="text-xs font-medium text-muted-foreground">{children}</span>
  );
}

function DetailRow({
  label,
  value,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly testId: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm tabular text-foreground" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

function AutomationToggle({
  kind,
  running,
  onStart,
  onStop,
}: {
  readonly kind: Ipc.ProviderKind;
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
      data-testid={`automation-toggle-${kind}`}
    >
      {running ? (
        <>
          <Stop aria-hidden="true" weight="fill" />
          Stop
        </>
      ) : (
        <>
          <Play aria-hidden="true" weight="fill" />
          Start
        </>
      )}
    </Button>
  );
}

/** Epoch ms → a short local time; `null` (never polled) reads as a dash. */
function formatTime(ms: number | null): string {
  if (ms === null) {
    return "—";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(ms));
}
