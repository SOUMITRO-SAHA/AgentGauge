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
import { useEffect, useState, type ReactElement } from "react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Play, Stop } from "@phosphor-icons/react";

import { automationAtom, kickoffAtom, subscriptionsAtom } from "~/atoms";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { KickoffSection } from "~/components/automation/kickoff-section";
import { ViewHeader } from "~/components/views/view-header";
import { PANEL, PanelHeader } from "~/components/dashboard/panel";
import { useClock } from "~/hooks/use-clock";
import * as Ipc from "~/lib/ipc";
import { tabsFrom, type UsageTab } from "~/lib/usage";

export function AutomationView({ visible }: { readonly visible: boolean }) {
  const [selectedTab, setSelectedTab] = useState<string | null>(null);
  const automation = useAtomValue(automationAtom);
  const refreshAutomation = useAtomRefresh(automationAtom);
  const refreshKickoff = useAtomRefresh(kickoffAtom);
  const subscriptions = useAtomValue(subscriptionsAtom);
  const nowMs = useClock();

  // Opening the screen re-reads: the retained answer paints instantly, and
  // the current monitor states land underneath — monitor state is exactly the
  // thing that changes while the app was looking elsewhere.
  useEffect(() => {
    if (visible) {
      refreshAutomation();
      refreshKickoff();
    }
  }, [visible, refreshAutomation, refreshKickoff]);

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
        subtitle="Monitor reported resets and configure optional kickoff actions per connection."
      />

      {AsyncResult.match(automation, {
        onInitial: () => <AutomationLoadingSkeleton />,
        onFailure: () => (
          <p className="text-sm text-destructive" data-testid="automation-error">
            The app could not be reached.
          </p>
        ),
        onSuccess: (result) => {
          if (tabs.length === 0) {
            return (
              <p className="text-sm text-muted-foreground">
                No readable connections are available for automation.
              </p>
            );
          }

          const connections = tabs.map((tab) => {
            const monitor =
              result.value.find((item) => item.kind === tab.kind) ?? null;

            return {
              tab,
              monitor,
              status:
                monitor === null
                  ? "Unavailable"
                  : monitor.running
                    ? "Running"
                    : "Stopped",
            };
          });
          const activeTab =
            tabs.find((tab) => tab.value === selectedTab)?.value ??
            tabs[0].value;

          return (
            <Tabs
              value={activeTab}
              onValueChange={setSelectedTab}
              className="flex flex-col gap-4"
              data-testid="automation-connections"
            >
              <TabsList
                aria-label="Automation connections"
                className="!grid !h-auto w-full grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-1 rounded-lg border border-border/70 bg-surface-raised/60 p-1"
              >
                {connections.map(({ tab, status }) => (
                  <TabsTrigger
                    key={tab.value}
                    value={tab.value}
                    className="!h-auto min-w-0 flex-col items-start gap-1 px-3 py-2 text-left whitespace-normal"
                    data-testid={`automation-connection-tab-${tab.kind}`}
                  >
                    <span className="max-w-full break-words">{tab.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {status}
                    </span>
                  </TabsTrigger>
                ))}
              </TabsList>

              {connections.map(({ tab, monitor }) => (
                <TabsContent
                  key={tab.value}
                  value={tab.value}
                  className="mt-0"
                >
                  <MonitorCard
                    tab={tab}
                    monitor={monitor}
                    onChanged={refreshAutomation}
                    nowMs={nowMs}
                  />
                </TabsContent>
              ))}
            </Tabs>
          );
        },
      })}

      <p className="text-xs leading-relaxed text-muted-foreground">
        Rollover monitors only read. Scheduled kickoff is a separate, opt-in
        action that uses quota; a prompt cannot create, reset, or extend a usage
        window. Monitor choices are remembered and resume when AgentGauge opens.
      </p>
    </div>
  );
}

function AutomationLoadingSkeleton() {
  return (
    <section className={PANEL} data-testid="automation-loading">
      <div
        className="flex flex-col gap-4"
        data-testid="automation-loading-skeleton"
        role="status"
        aria-label="Loading automation settings"
      >
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-4 w-36" aria-hidden="true" />
          <Skeleton className="size-8" aria-hidden="true" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-4 w-20" aria-hidden="true" />
          <Skeleton className="h-8 w-20 rounded-md" aria-hidden="true" />
        </div>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-3 w-20" aria-hidden="true" />
          <div className="flex justify-between gap-3">
            <Skeleton className="h-4 w-32" aria-hidden="true" />
            <Skeleton className="h-4 w-24" aria-hidden="true" />
          </div>
          <div className="flex justify-between gap-3">
            <Skeleton className="h-4 w-36" aria-hidden="true" />
            <Skeleton className="h-4 w-24" aria-hidden="true" />
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-border/60 pt-4">
          <Skeleton className="h-3 w-12" aria-hidden="true" />
          <div className="flex justify-between gap-3">
            <Skeleton className="h-4 w-20" aria-hidden="true" />
            <Skeleton className="h-4 w-24" aria-hidden="true" />
          </div>
          <div className="flex justify-between gap-3">
            <Skeleton className="h-4 w-16" aria-hidden="true" />
            <Skeleton className="h-4 w-24" aria-hidden="true" />
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-border/60 pt-4">
          <Skeleton className="h-3 w-32" aria-hidden="true" />
          <Skeleton className="h-4 w-full" aria-hidden="true" />
          <div className="flex flex-wrap gap-3">
            <Skeleton
              className="h-9 w-full max-w-56 rounded-md"
              aria-hidden="true"
            />
            <Skeleton
              className="h-9 w-full max-w-56 rounded-md"
              aria-hidden="true"
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function MonitorCard({
  tab,
  monitor,
  onChanged,
  nowMs,
}: {
  readonly tab: UsageTab & { kind: NonNullable<UsageTab["kind"]> };
  readonly monitor: Ipc.AutomationState | null;
  readonly onChanged: () => void;
  readonly nowMs: number;
}): ReactElement {
  const kind = tab.kind;
  const running = monitor?.running ?? false;

  return (
    <section className={PANEL} data-testid={`automation-panel-${kind}`}>
      <PanelHeader
        title={tab.label}
        testId={`refresh-automation-${kind}`}
        onRefresh={onChanged}
      />

      {monitor === null ? (
        <p className="text-sm text-muted-foreground">
          Monitor status is unavailable for this connection.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-surface/60 p-3">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">Rollover monitor</span>
              <span
                className="text-xs text-muted-foreground"
                data-testid={`automation-status-${kind}`}
              >
                {running ? "Running" : "Stopped"}
              </span>
            </div>
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

          <div className="grid gap-4 sm:grid-cols-2">
            <RolloverDetails kind={kind} monitor={monitor} onChanged={onChanged} />
            <WatchSchedule kind={kind} monitor={monitor} />
          </div>
        </div>
      )}

      <div className="border-t border-border/60 pt-4">
        <KickoffSection kind={kind} nowMs={nowMs} />
      </div>
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
        value={formatTime(monitor.observedResetsAt, "Not reported")}
      />
      <DetailRow
        testId={`automation-rolled-over-at-${kind}`}
        label="Rollover detected at"
        value={formatTime(monitor.rolledOverAt, "Not detected")}
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
        value={formatTime(monitor.lastPolledAt, "Not checked")}
      />
      <DetailRow
        testId={`automation-next-poll-${kind}`}
        label="Next check"
        value={formatTime(monitor.nextPollAt, "Not scheduled")}
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

function formatTime(ms: number | null, missing: string): string {
  if (ms === null) {
    return missing;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(ms));
}
