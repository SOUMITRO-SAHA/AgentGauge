/**
 * Processes: what the agent toolchain is doing to this machine, read-only.
 *
 * One panel per group — AgentGauge itself, then each tracked CLI — straight
 * from the report: the groups the backend sends are the groups on screen, so
 * adding a future CLI is a backend addition with no renderer change. Every
 * value is one snapshot: memory is point-in-time from the read, uptime ticks
 * against the shared clock, and storage is measured, or its absence carries
 * a reason.
 *
 * Owns the process testids (`process-panel-*`, `process-row-*`,
 * `process-storage-*`, `process-refreshing`, `process-readonly-note`) and
 * the loading/error states for the whole read.
 */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useEffect } from "react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";

import { processInsightsAtom } from "~/atoms";
import {
  ProcessGroupPanel,
  ProcessInsightsError,
} from "~/components/process/process-group-panel";
import { ViewHeader } from "~/components/views/view-header";
import { PANEL } from "~/components/dashboard/panel";
import { useClock } from "~/hooks/use-clock";

export function ProcessView({ visible }: { readonly visible: boolean }) {
  const insights = useAtomValue(processInsightsAtom);
  const refresh = useAtomRefresh(processInsightsAtom);
  const nowMs = useClock();

  // Opening the screen re-reads: the retained snapshot paints instantly, and
  // the current process table lands underneath — which processes exist is
  // exactly what changes while the app was looking elsewhere.
  useEffect(() => {
    if (visible) {
      refresh();
    }
  }, [visible, refresh]);

  return (
    <div
      className={visible ? "flex flex-col gap-4" : "hidden"}
      data-testid="view-processes"
    >
      <ViewHeader
        title="Processes"
        subtitle="A read-only look at the processes and storage the agent toolchain uses."
      />

      {AsyncResult.match(insights, {
        onInitial: () => (
          <section className={PANEL} data-testid="process-loading">
            <div className="flex flex-col gap-3">
              <div className="h-4 w-40 animate-pulse rounded bg-muted" />
              <div className="h-4 w-64 animate-pulse rounded bg-muted" />
            </div>
          </section>
        ),
        onFailure: () => <ProcessInsightsError />,
        onSuccess: (result) => (
          <>
            {result.waiting ? (
              <p
                className="text-xs text-muted-foreground"
                data-testid="process-refreshing"
              >
                Refreshing · showing the previous reading until it completes.
              </p>
            ) : null}
            {result.value.groups.map((group) => (
              <ProcessGroupPanel key={group.id} group={group} nowMs={nowMs} />
            ))}
            <p
              className="text-xs leading-relaxed text-muted-foreground"
              data-testid="process-readonly-note"
            >
              This screen only reads. Nothing here can stop a process or delete
              a file. Memory is a snapshot from the moment of the read; uptime
              counts from each process's start.
            </p>
          </>
        ),
      })}
    </div>
  );
}
