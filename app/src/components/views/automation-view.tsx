/**
 * Automation: the rollover monitor.
 *
 * The monitor's one job is to *detect* the moment a window rolls over — never
 * to cause one. That boundary is stated in the copy here, not just implemented
 * in Rust, because it is the single most misunderstood thing about the feature:
 * a 5-hour window cannot be restarted by a prompt, and sending a prompt spends
 * the account's quota rather than opening a new window.
 *
 * Owns `automation-panel`, `refresh-automation`, `automation-status`,
 * `automation-toggle` — the testids the dashboard historically had — plus the
 * rollover detail the old panel never showed.
 */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Effect from "effect/Effect";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Play, Stop } from "@phosphor-icons/react";

import { automationAtom } from "~/atoms";
import { Button } from "~/components/ui/button";
import { ViewHeader } from "~/components/views/view-header";
import { PANEL, PanelHeader } from "~/components/dashboard/panel";
import * as Ipc from "~/lib/ipc";

export function AutomationView({ visible }: { readonly visible: boolean }) {
  const automation = useAtomValue(automationAtom);
  const refreshAutomation = useAtomRefresh(automationAtom);

  return (
    <div className={visible ? "flex flex-col gap-4" : "hidden"} data-testid="view-automation">
      <ViewHeader title="Automation" subtitle="Watching for the moment a window resets." />

      <section className={PANEL} data-testid="automation-panel">
        <PanelHeader
          title="Rollover monitor"
          testId="refresh-automation"
          onRefresh={refreshAutomation}
        />

        {AsyncResult.match(automation, {
          onInitial: () => (
            <p className="text-sm text-muted-foreground">
              Checking the monitor…
            </p>
          ),
          onSuccess: (result) => {
            const state = result.value;
            return (
              <div className="flex flex-col gap-4">
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

                <RolloverDetails state={state} onChanged={refreshAutomation} />
                <WatchSchedule state={state} />
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

      <p className="text-xs leading-relaxed text-muted-foreground">
        The monitor only reads. A 5-hour window cannot be restarted by a prompt
        — sending one consumes the current window, so nothing is ever sent: a
        rollover is detected, never caused.
      </p>
    </div>
  );
}

/**
 * Rollover facts: the reset the source last reported, and the transition the
 * monitor detected. The PRD separates a *reported* reset from an *observed*
 * rollover, so the labels must too.
 */
function RolloverDetails({
  state,
  onChanged,
}: {
  readonly state: Ipc.AutomationState;
  readonly onChanged: () => void;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid="automation-rollover">
      <DetailGroupLabel>Rollover</DetailGroupLabel>
      <DetailRow
        testId="automation-observed-reset"
        label="Last reported reset"
        value={formatTime(state.observedResetsAt)}
      />
      <DetailRow
        testId="automation-rolled-over-at"
        label="Rollover detected at"
        value={formatTime(state.rolledOverAt)}
      />

      {state.rolledOver && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-warn" data-testid="automation-rolled-over">
            A fresh window was detected.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void Effect.runPromise(Ipc.acknowledgeRollover()).then(onChanged);
            }}
            data-testid="automation-acknowledge"
          >
            Acknowledge
          </Button>
        </div>
      )}
    </div>
  );
}

function WatchSchedule({ state }: { readonly state: Ipc.AutomationState }) {
  return (
    <div className="flex flex-col gap-2" data-testid="automation-schedule">
      <DetailGroupLabel>Checks</DetailGroupLabel>
      <DetailRow
        testId="automation-last-polled"
        label="Last checked"
        value={formatTime(state.lastPolledAt)}
      />
      <DetailRow
        testId="automation-next-poll"
        label="Next check"
        value={formatTime(state.nextPollAt)}
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
