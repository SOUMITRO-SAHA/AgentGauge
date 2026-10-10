/**
 * Automation: the window watcher.
 *
 * The watcher's one job is to *detect* the moment a window resets — never to
 * cause one. That boundary is stated in the copy here, not just implemented in
 * Rust, because it is the single most misunderstood thing about the feature: a
 * 5-hour window cannot be restarted by a prompt, and sending a prompt spends
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
import { PANEL, PanelHeader } from "~/components/dashboard/panel";
import * as Ipc from "~/lib/ipc";

export function AutomationView({ visible }: { readonly visible: boolean }) {
  const automation = useAtomValue(automationAtom);
  const refreshAutomation = useAtomRefresh(automationAtom);

  return (
    <div className={visible ? "block" : "hidden"} data-testid="view-automation">
      <header className="flex flex-col gap-1">
        <h1 className="text-[clamp(1.25rem,4vw,1.5rem)] font-semibold tracking-tight text-foreground">
          Automation
        </h1>
        <p className="text-sm text-muted-foreground">
          Watching for the moment a window resets.
        </p>
      </header>

      <section className={PANEL} data-testid="automation-panel">
        <PanelHeader
          title="Window watcher"
          testId="refresh-automation"
          onRefresh={refreshAutomation}
        />

        {AsyncResult.match(automation, {
          onInitial: () => (
            <p className="text-sm text-muted-foreground">
              Checking the watcher…
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
        The watcher only reads. A 5-hour window cannot be restarted by a prompt
        — sending one consumes the current window, so the watcher never sends
        anything and a reset is detected, never caused.
      </p>
    </div>
  );
}

/** Rollover state: shown as facts, with an acknowledge only when one happened. */
function RolloverDetails({
  state,
  onChanged,
}: {
  readonly state: Ipc.AutomationState;
  readonly onChanged: () => void;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid="automation-rollover">
      <DetailRow
        testId="automation-observed-reset"
        label="Window reset observed at"
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
    <div className="flex flex-col gap-2">
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
