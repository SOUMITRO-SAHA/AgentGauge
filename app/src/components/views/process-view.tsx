/**
 * Processes: what the agent toolchain is doing to this machine, read-only.
 *
 * One panel per group — each tracked CLI the backend reports — straight from
 * the report, so adding a future CLI is a backend addition with no renderer
 * change. Every value is one snapshot: memory is point-in-time from the
 * read, uptime ticks against the shared clock, and storage is measured, or
 * its absence carries a reason.
 *
 * Layout stability is part of the flow: the loading skeleton mirrors the
 * success shape (one skeleton panel per expected group plus the note), and
 * the refresh-status line is a permanently mounted slot that toggles
 * visibility — so neither the first read completing nor a refresh settling
 * can move the panels.
 *
 * Owns the process testids (`process-panel-*`, `process-row-*`,
 * `process-storage-*`, `process-refreshing`, `process-loading-*`) and the
 * loading/error states for the whole read.
 */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useEffect } from "react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";

import { processInsightsAtom } from "~/atoms";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import {
  ProcessGroupPanel,
  ProcessInsightsError,
} from "~/components/process/process-group-panel";
import { ViewHeader } from "~/components/views/view-header";
import { PANEL } from "~/components/dashboard/panel";
import { useClock } from "~/hooks/use-clock";
import { cn } from "~/lib/utils";

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

  const refreshing = AsyncResult.match(insights, {
    onInitial: () => false,
    onFailure: () => false,
    onSuccess: (result) => result.waiting,
  });

  return (
    <div
      className={visible ? "flex min-w-0 flex-col gap-4" : "hidden min-w-0"}
      data-testid="view-processes"
    >
      <ViewHeader
        title="Processes"
        subtitle="A read-only look at the processes and storage the agent toolchain uses."
      />

      {/* Mounted in every state and hidden by visibility rather than
          unmounted: when a refresh settles, the line it held disappears
          without the panels below moving up into its box. */}
      <p
        className={cn(
          "text-xs text-muted-foreground",
          refreshing ? "visible" : "invisible",
        )}
        data-testid="process-refreshing"
      >
        Refreshing · showing the previous reading until it completes.
      </p>

      {AsyncResult.match(insights, {
        onInitial: () => <ProcessLoadingSkeleton />,
        onFailure: () => <ProcessInsightsError />,
        onSuccess: (result) => (
          <>
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

/**
 * How many group panels the skeleton reserves.
 *
 * Mirrors the tracked tools the backend reports (Codex and OpenCode today);
 * when a tool is added there, this follows in the same change so the
 * skeleton keeps predicting the success shape.
 */
const SKELETON_PANELS = 2;

function ProcessLoadingSkeleton() {
  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      data-testid="process-loading-skeleton"
      role="status"
      aria-label="Loading process details"
    >
      {Array.from({ length: SKELETON_PANELS }, (_, index) => (
        <SkeletonPanel key={index} />
      ))}
      <div
        className="flex flex-col gap-1.5 pt-1"
        data-testid="process-loading-note"
        aria-hidden="true"
      >
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/5" />
      </div>
    </div>
  );
}

/** One group panel's shape at rest: header, totals, rows, storage. */
function SkeletonPanel() {
  return (
    <section className={`${PANEL} min-w-0`} data-testid="process-loading-panel">
      <div className="mb-4 flex items-center justify-between gap-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="size-8" />
      </div>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4">
          <SkeletonTotal className="w-14" valueClassName="w-20" />
          <SkeletonTotal className="w-16" valueClassName="w-12" />
          <SkeletonTotal className="w-12" valueClassName="w-24" />
          <SkeletonTotal className="w-12" valueClassName="w-16" />
        </div>
        <Table className="table-fixed min-w-full">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[68%] pl-0 pr-1 lg:w-[54%] 2xl:w-[36%]">
                <Skeleton className="h-4 w-2/5" />
              </TableHead>
              <TableHead className="hidden w-[12%] text-right 2xl:table-cell">
                <Skeleton className="ml-auto h-3 w-10" />
              </TableHead>
              <TableHead className="hidden w-[14%] text-right 2xl:table-cell">
                <Skeleton className="ml-auto h-3 w-12" />
              </TableHead>
              <TableHead className="w-[32%] px-1 text-right lg:w-[26%] 2xl:w-[18%]">
                <Skeleton className="ml-auto h-3 w-12" />
              </TableHead>
              <TableHead className="hidden w-[20%] pr-0 text-right lg:table-cell 2xl:w-[20%]">
                <Skeleton className="ml-auto h-3 w-14" />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[0, 1].map((row) => (
              <TableRow key={row}>
                <TableCell className="min-w-0 overflow-hidden pl-0 pr-1 whitespace-normal">
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Skeleton className="h-4 w-2/5" />
                    <Skeleton className="h-3 w-3/5" />
                    <div className="flex min-w-0 flex-wrap gap-2 2xl:hidden">
                      <Skeleton className="h-3 w-16" />
                      <Skeleton className="h-3 w-20" />
                      <Skeleton className="h-3 w-12 lg:hidden" />
                    </div>
                  </div>
                </TableCell>
                <TableCell className="hidden text-right 2xl:table-cell">
                  <Skeleton className="ml-auto h-3 w-10" />
                </TableCell>
                <TableCell className="hidden text-right 2xl:table-cell">
                  <Skeleton className="ml-auto h-4 w-12" />
                </TableCell>
                <TableCell className="px-1 text-right">
                  <Skeleton className="ml-auto h-4 w-14" />
                </TableCell>
                <TableCell className="hidden text-right lg:table-cell">
                  <Skeleton className="ml-auto h-4 w-14" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex flex-col gap-3 border-t border-border/60 pt-4">
          <Skeleton className="h-3 w-20" />
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-16" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
      </div>
    </section>
  );
}

/** One totals chip: a label line above a value line. */
function SkeletonTotal({
  className,
  valueClassName,
}: {
  readonly className: string;
  readonly valueClassName: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className={cn("h-3", className)} />
      <Skeleton className={cn("h-4", valueClassName)} />
    </div>
  );
}
