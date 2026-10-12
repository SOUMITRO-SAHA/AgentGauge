/**
 * One group's panel on the Processes screen: the processes running right now
 * with their memory and age, and the storage the group owns on disk.
 *
 * Everything here is a rendering of one snapshot — there is no control to
 * stop, signal, or delete anything, because the protocol offers none. The
 * refresh action is the only interaction, and it re-reads.
 */

import { useAtomRefresh } from "@effect/atom-react";
import { HardDrive, Warning } from "@phosphor-icons/react";

import { processInsightsAtom } from "~/atoms";
import { PANEL, PanelHeader } from "~/components/dashboard/panel";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { formatBytes } from "~/lib/format";
import { formatCountdown } from "~/lib/usage";
import type * as Ipc from "~/lib/ipc";

export function ProcessGroupPanel({
  group,
  nowMs,
}: {
  readonly group: Ipc.ProcessGroup;
  readonly nowMs: number;
}) {
  const refresh = useAtomRefresh(processInsightsAtom);

  return (
    <section className={PANEL} data-testid={`process-panel-${group.id}`}>
      <PanelHeader
        title={group.displayName}
        testId={`refresh-processes-${group.id}`}
        onRefresh={() => refresh()}
      />

      <div className="flex flex-col gap-4">
        <Totals group={group} />
        <Processes group={group} nowMs={nowMs} />
        <Storage group={group} />
        <PortsUnavailable group={group} />
      </div>
    </section>
  );
}

function Totals({ group }: { readonly group: Ipc.ProcessGroup }) {
  const onDisk =
    group.storage.state === "measured"
      ? `${formatBytes(group.storage.totalBytes)} · ${group.storage.totalFiles} files`
      : "—";
  const ports =
    group.ports.state === "checked"
      ? uniquePorts(group).join(", ") || "None listening"
      : "—";

  return (
    <div
      className="flex flex-wrap gap-x-8 gap-y-2"
      data-testid={`process-totals-${group.id}`}
    >
      <Total label="Memory" value={formatBytes(group.totalMemoryBytes)} />
      <Total label="Processes" value={String(group.processes.length)} />
      <Total label="Ports" value={ports} />
      <Total label="On disk" value={onDisk} />
    </div>
  );
}

/** The group's listening ports, unique and ascending. */
function uniquePorts(group: Ipc.ProcessGroup): number[] {
  if (group.ports.state !== "checked") {
    return [];
  }
  const ports = [
    ...new Set(group.ports.listening.map((entry) => entry.port)),
  ];
  ports.sort((a, b) => a - b);
  return ports;
}

/** The honest reason the ports question could not be asked at all. */
function PortsUnavailable({ group }: { readonly group: Ipc.ProcessGroup }) {
  if (group.ports.state !== "unavailable") {
    return null;
  }
  return (
    <p
      className="text-xs text-muted-foreground"
      data-testid={`process-ports-unavailable-${group.id}`}
    >
      {group.ports.reason}
    </p>
  );
}

function Total({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular text-foreground">{value}</span>
    </span>
  );
}

function Processes({
  group,
  nowMs,
}: {
  readonly group: Ipc.ProcessGroup;
  readonly nowMs: number;
}) {
  if (group.processes.length === 0) {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid={`process-empty-${group.id}`}
      >
        No {group.displayName} processes are running right now.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-0">Process</TableHead>
          <TableHead className="text-right">PID</TableHead>
          <TableHead className="text-right">Ports</TableHead>
          <TableHead className="text-right">Memory</TableHead>
          <TableHead className="pr-0 text-right">Uptime</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {group.processes.map((process) => (
          <TableRow key={process.pid} data-testid={`process-row-${process.pid}`}>
            <TableCell className="max-w-[24rem] pl-0">
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-foreground">
                  {process.name}
                </span>
                {process.command !== null && (
                  <span className="truncate text-xs text-muted-foreground">
                    {process.command}
                  </span>
                )}
              </div>
            </TableCell>
            <TableCell className="text-right text-xs tabular text-muted-foreground">
              {process.pid}
            </TableCell>
            <TableCell
              className="text-right text-sm tabular text-foreground"
              data-testid={`process-ports-${process.pid}`}
            >
              {process.listeningPorts.map((port) => `:${port}`).join(" ")}
            </TableCell>
            <TableCell
              className="text-right text-sm tabular text-foreground"
              data-testid={`process-memory-${process.pid}`}
            >
              {process.memoryBytes === null ? "Unknown" : formatBytes(process.memoryBytes)}
            </TableCell>
            <TableCell
              className="pr-0 text-right text-sm tabular text-foreground"
              data-testid={`process-uptime-${process.pid}`}
            >
              {formatCountdown(uptimeMs(process, nowMs)) ?? "Unknown"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The process's age at the rendered instant, or nothing when unknown. */
function uptimeMs(process: Ipc.ProcessSummary, nowMs: number): number | null {
  if (process.startedAt === null) {
    return null;
  }
  const uptime = nowMs - process.startedAt * 1_000;
  return uptime >= 0 ? uptime : null;
}

function Storage({ group }: { readonly group: Ipc.ProcessGroup }) {
  if (group.storage.state === "absent") {
    return (
      <div
        className="flex items-start gap-3 border-t border-border/60 pt-4"
        data-testid={`process-storage-absent-${group.id}`}
      >
        <HardDrive className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">{group.storage.reason}</p>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-2 border-t border-border/60 pt-4"
      data-testid={`process-storage-${group.id}`}
    >
      <span className="text-xs font-medium text-muted-foreground">Storage</span>
      {group.storage.rows.map((row) => (
        <div
          key={`${row.label}-${row.path}`}
          className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5"
          data-testid={`process-storage-row-${group.id}`}
        >
          <span className="min-w-0 truncate text-sm text-muted-foreground">
            {row.label}
            <span className="ml-2 text-xs text-muted-foreground/70">{row.path}</span>
          </span>
          <span className="text-sm tabular text-foreground">
            {formatBytes(row.bytes)}
            <span className="ml-2 text-xs text-muted-foreground">
              {row.fileCount} files
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** The whole-screen failure state: the read itself could not be made. */
export function ProcessInsightsError() {
  return (
    <section className={PANEL} data-testid="process-error">
      <div className="flex items-center gap-3">
        <Warning className="size-4 shrink-0 text-critical" aria-hidden="true" />
        <span className="text-sm text-muted-foreground">
          The process list could not be read.
        </span>
      </div>
    </section>
  );
}
