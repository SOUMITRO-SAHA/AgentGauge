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
import { Skeleton } from "~/components/ui/skeleton";
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
        onInitial: () => <ProcessLoadingSkeleton />,
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

function ProcessLoadingSkeleton() {
  return (
    <section className={PANEL} data-testid="process-loading">
      <div
        className="flex flex-col gap-4"
        data-testid="process-loading-skeleton"
        role="status"
        aria-label="Loading process details"
      >
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-4 w-32" aria-hidden="true" />
          <Skeleton className="size-8" aria-hidden="true" />
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-14" aria-hidden="true" />
            <Skeleton className="h-4 w-20" aria-hidden="true" />
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-16" aria-hidden="true" />
            <Skeleton className="h-4 w-12" aria-hidden="true" />
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-12" aria-hidden="true" />
            <Skeleton className="h-4 w-24" aria-hidden="true" />
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-12" aria-hidden="true" />
            <Skeleton className="h-4 w-16" aria-hidden="true" />
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-4 w-2/5" aria-hidden="true" />
            <Skeleton className="h-3 w-16" aria-hidden="true" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-4 w-1/3" aria-hidden="true" />
            <Skeleton className="h-3 w-16" aria-hidden="true" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-4 w-1/2" aria-hidden="true" />
            <Skeleton className="h-3 w-16" aria-hidden="true" />
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-border/60 pt-4">
          <Skeleton className="h-3 w-20" aria-hidden="true" />
          <Skeleton className="h-4 w-3/4" aria-hidden="true" />
          <Skeleton className="h-4 w-1/2" aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}
