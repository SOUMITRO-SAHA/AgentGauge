/**
 * Processes: what the agent toolchain is doing to this machine, read-only.
 *
 * One tab per group — each tracked CLI the backend reports, in the
 * Automation screen's tab shape — straight from the report, so adding a
 * future CLI is a backend addition with no renderer change. Every value is
 * one snapshot: memory and CPU are point-in-time from the read, uptime ticks
 * against the shared clock, and storage is measured, or its absence carries
 * a reason.
 *
 * Layout stability is part of the flow: the loading skeleton mirrors the
 * success shape (one tab ghost per expected group, one panel ghost, and the
 * meta/note ghost), and the refresh-status line is a permanently mounted
 * slot that toggles visibility — so neither the first read completing nor a
 * refresh settling can move the tabs. The read's age and the cross-group
 * summary sit with the read-only note below the tabs for the same reason:
 * they join a region that already flexes, instead of introducing a new slot
 * whose appearance would shift the layout.
 *
 * Tabs are view navigation, not actions: switching one changes which group
 * is rendered, and the refresh inside each panel remains the only
 * interaction that re-reads.
 *
 * Owns the process testids (`process-tab-*`, `process-panel-*`,
 * `process-row-*`, `process-storage-*`, `process-meta`,
 * `process-refreshing`, `process-loading-*`) and the loading/error states
 * for the whole read.
 */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useEffect, useState } from "react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";

import { processInsightsAtom } from "~/atoms";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "~/components/ui/tabs";
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
import { FreshnessPill } from "~/components/usage/provider-status-card";
import { ViewHeader } from "~/components/views/view-header";
import { PANEL } from "~/components/dashboard/panel";
import { useClock } from "~/hooks/use-clock";
import { formatBytes } from "~/lib/format";
import { failureReason } from "~/lib/ipc";
import { formatFreshness, STALE_AFTER_MS } from "~/lib/usage";
import type * as Ipc from "~/lib/ipc";
import { cn } from "~/lib/utils";

export function ProcessView({ visible }: { readonly visible: boolean }) {
  const insights = useAtomValue(processInsightsAtom);
  const refresh = useAtomRefresh(processInsightsAtom);
  const nowMs = useClock();
  const [selectedTab, setSelectedTab] = useState<string | null>(null);

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

      <p
        className={cn(
          "text-xs text-muted-foreground",
          refreshing ? "visible" : "invisible",
        )}
        data-testid="process-refreshing"
      >
        Refreshing · loading updated process details.
      </p>

      {AsyncResult.match(insights, {
        onInitial: () => <ProcessLoadingSkeleton />,
        onFailure: (error) => (
          <ProcessInsightsError
            message={failureReason(error.cause)}
            onRetry={() => refresh()}
          />
        ),
        onSuccess: (result) => {
          if (result.waiting) {
            return <ProcessLoadingSkeleton />;
          }

          const groups = result.value.groups;
          const activeTab =
            groups.find((group) => group.id === selectedTab)?.id ??
            groups[0]?.id;

          return (
            <>
              <Tabs
                value={activeTab}
                onValueChange={setSelectedTab}
                className="flex min-w-0 flex-col gap-4"
                data-testid="process-groups"
              >
                <TabsList
                  aria-label="Process groups"
                  className="!grid !h-auto w-full grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-1 rounded-lg border border-border/70 bg-surface-raised/60 p-1"
                >
                  {groups.map((group) => (
                    <TabsTrigger
                      key={group.id}
                      value={group.id}
                      className="!h-auto min-w-0 flex-col items-start gap-1 px-3 py-2 text-left whitespace-normal"
                      data-testid={`process-tab-${group.id}`}
                    >
                      <span className="max-w-full break-words">
                        {group.displayName}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {groupGlance(group)}
                      </span>
                    </TabsTrigger>
                  ))}
                </TabsList>

                {groups.map((group) => (
                  <TabsContent
                    key={group.id}
                    value={group.id}
                    className="mt-0"
                  >
                    <ProcessGroupPanel group={group} nowMs={nowMs} />
                  </TabsContent>
                ))}
              </Tabs>
              <ReadingMeta
                fetchedAt={result.value.fetchedAt}
                groups={groups}
                nowMs={nowMs}
              />
              <p
                className="text-xs leading-relaxed text-muted-foreground"
                data-testid="process-readonly-note"
              >
                This screen only reads. Nothing here can stop a process or delete
                a file. Memory, CPU, and storage are a snapshot from the moment
                of the read — CPU above 100% spans several cores — and uptime
                counts from each process's start.
              </p>
            </>
          );
        },
      })}
    </div>
  );
}

/**
 * The one-line answer each tab carries before it is opened: what the group is
 * doing right now, or that it is doing nothing.
 */
function groupGlance(group: Ipc.ProcessGroup): string {
  if (group.processes.length === 0) {
    return "No processes";
  }
  return `${counted(group.processes.length, "process", "processes")} · ${formatBytes(group.totalMemoryBytes)}`;
}

/** When the reading was taken, and what it covers across every group. */
function ReadingMeta({
  fetchedAt,
  groups,
  nowMs,
}: {
  readonly fetchedAt: number;
  readonly groups: ReadonlyArray<Ipc.ProcessGroup>;
  readonly nowMs: number;
}) {
  const relative = formatFreshness(fetchedAt, nowMs) ?? "just now";
  const stale = nowMs - fetchedAt > STALE_AFTER_MS;

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2"
      data-testid="process-meta"
    >
      <FreshnessPill
        freshness={stale ? "stale" : "live"}
        label={stale ? `Stale · read ${relative}` : `Read ${relative}`}
      />
      <p className="text-xs text-muted-foreground" data-testid="process-summary">
        {summaryLine(groups)}
      </p>
    </div>
  );
}

/**
 * The toolchain totals across groups, from one snapshot: consistent by
 * construction. On-disk sums measured roots only, and says so when any
 * group's root could not be measured at all.
 */
function summaryLine(groups: ReadonlyArray<Ipc.ProcessGroup>): string {
  const processes = groups.reduce(
    (sum, group) => sum + group.processes.length,
    0,
  );
  const memory = groups.reduce(
    (sum, group) => sum + group.totalMemoryBytes,
    0,
  );
  const disk = groups.reduce(
    (sum, group) =>
      sum + (group.storage.state === "measured" ? group.storage.totalBytes : 0),
    0,
  );
  const parts = [
    counted(groups.length, "group", "groups"),
    counted(processes, "process", "processes"),
    `${formatBytes(memory)} memory`,
    `${formatBytes(disk)} on disk`,
  ];
  if (groups.some((group) => group.storage.state === "absent")) {
    parts.push("measured roots only");
  }
  return parts.join(" · ");
}

/** A count with its noun, in the form the count calls for. */
function counted(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * How many tab ghosts the skeleton reserves.
 *
 * Mirrors the tracked tools the backend reports (Codex and OpenCode today);
 * when a tool is added there, this follows in the same change so the
 * skeleton keeps predicting the success shape. One panel ghost is enough
 * beside them: only the active tab's panel is on screen.
 */
const SKELETON_TABS = 2;

function ProcessLoadingSkeleton() {
  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      data-testid="process-loading-skeleton"
      role="status"
      aria-label="Loading process details"
    >
      <div
        className="grid w-full grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-1 rounded-lg border border-border/70 bg-surface-raised/60 p-1"
        data-testid="process-loading-tabs"
        aria-hidden="true"
      >
        {Array.from({ length: SKELETON_TABS }, (_, index) => (
          <div
            key={index}
            className="flex flex-col gap-1.5 px-3 py-2"
            data-testid="process-loading-tab"
          >
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ))}
      </div>
      <SkeletonPanel />
      <div
        className="flex flex-col gap-2 pt-1"
        data-testid="process-loading-note"
        aria-hidden="true"
      >
        <div className="flex items-center gap-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-40" />
        </div>
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
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          <SkeletonTotal className="w-10" valueClassName="w-16" />
          <SkeletonTotal className="w-14" valueClassName="w-20" />
          <SkeletonTotal className="w-16" valueClassName="w-12" />
          <SkeletonTotal className="w-12" valueClassName="w-24" />
          <SkeletonTotal className="w-12" valueClassName="w-16" />
        </div>
        <Table className="table-fixed min-w-full">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[68%] pl-0 pr-1 lg:w-[54%] 2xl:w-[32%]">
                <Skeleton className="h-4 w-2/5" />
              </TableHead>
              <TableHead className="hidden w-[10%] text-right 2xl:table-cell">
                <Skeleton className="ml-auto h-3 w-10" />
              </TableHead>
              <TableHead className="hidden w-[14%] text-right 2xl:table-cell">
                <Skeleton className="ml-auto h-3 w-12" />
              </TableHead>
              <TableHead className="hidden w-[8%] text-right 2xl:table-cell">
                <Skeleton className="ml-auto h-3 w-8" />
              </TableHead>
              <TableHead className="w-[32%] px-1 text-right lg:w-[26%] 2xl:w-[16%]">
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
                      <Skeleton className="h-3 w-12" />
                      <Skeleton className="h-3 w-12 lg:hidden" />
                    </div>
                  </div>
                </TableCell>
                <TableCell className="hidden text-right 2xl:table-cell">
                  <Skeleton className="ml-auto h-3 w-10" />
                </TableCell>
                <TableCell className="hidden text-right 2xl:table-cell">
                  <Skeleton className="ml-auto h-3 w-12" />
                </TableCell>
                <TableCell className="hidden text-right 2xl:table-cell">
                  <Skeleton className="ml-auto h-3 w-8" />
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
