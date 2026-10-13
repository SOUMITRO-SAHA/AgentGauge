/**
 * One group's panel on the Processes screen: the processes running right now
 * with their memory, CPU share, age, and listening endpoints, and the
 * storage the group owns on disk.
 *
 * Everything here is a rendering of one snapshot — there is no control to
 * stop, signal, or delete anything, because the protocol offers none. The
 * refresh action is the only interaction, and it re-reads.
 */

import { useAtomRefresh } from "@effect/atom-react";
import { ArrowClockwise, HardDrive, Warning } from "@phosphor-icons/react";

import { processInsightsAtom } from "~/atoms";
import { PANEL, PanelHeader } from "~/components/dashboard/panel";
import { Button } from "~/components/ui/button";
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
    <section
      className={`${PANEL} min-w-0`}
      data-testid={`process-panel-${group.id}`}
    >
      <PanelHeader
        title={group.displayName}
        testId={`refresh-processes-${group.id}`}
        onRefresh={() => refresh()}
      />

      <div className="flex min-w-0 flex-col gap-4">
        <Service group={group} />
        <Totals group={group} />
        <Processes group={group} nowMs={nowMs} />
        <Storage group={group} />
        <PortsUnavailable group={group} />
      </div>
    </section>
  );
}

/**
 * The tool's own record of its background service, shown only when Rust
 * confirmed its pid is one of this group's live processes.
 */
function Service({ group }: { readonly group: Ipc.ProcessGroup }) {
  if (group.service === null) {
    return null;
  }
  const parts = [
    group.service.version === null ? null : `v${group.service.version}`,
    group.service.url,
  ].filter((part): part is string => part !== null);

  return (
    <p
      className="text-xs text-muted-foreground"
      data-testid={`process-service-${group.id}`}
    >
      {["Background service", ...parts].join(" · ")}
    </p>
  );
}

function Totals({ group }: { readonly group: Ipc.ProcessGroup }) {
  const onDisk =
    group.storage.state === "measured"
      ? `${formatBytes(group.storage.totalBytes)} · ${group.storage.totalFiles} files`
      : "—";

  return (
    <div
      className="flex flex-wrap gap-x-8 gap-y-2"
      data-testid={`process-totals-${group.id}`}
    >
      <Total label="CPU" value={formatCpu(group.totalCpuUsage)} />
      <Total label="Memory" value={formatBytes(group.totalMemoryBytes)} />
      <Total label="Processes" value={String(group.processes.length)} />
      <Total label="Ports" value={portsTotals(group)} />
      <Total label="On disk" value={onDisk} />
    </div>
  );
}

/**
 * The group's listening endpoints as one honest value: each with the
 * interface it is bound to, a wildcard bind called out as reaching every
 * interface, and "None listening" only when the platform was actually asked.
 */
function portsTotals(group: Ipc.ProcessGroup): string {
  if (group.ports.state !== "checked") {
    return "—";
  }
  if (group.ports.listening.length === 0) {
    return "None listening";
  }
  const endpoints = [
    ...new Set(group.ports.listening.map(formatEndpoint)),
  ].sort();
  return endpoints
    .map((endpoint) =>
      isWildcard(endpoint) ? `${endpoint} · all interfaces` : endpoint,
    )
    .join(", ");
}

function formatEndpoint(entry: Ipc.ProcessPort): string {
  return entry.address === null
    ? `:${entry.port}`
    : `${entry.address}:${entry.port}`;
}

/** A bind that reaches every interface, not only loopback. */
function isWildcard(endpoint: string): boolean {
  const address = endpoint.slice(0, endpoint.lastIndexOf(":"));
  return address === "*" || address === "0.0.0.0" || address === "::";
}

/** One CPU share, `—` when the platform did not report a sample. */
function formatCpu(usage: number | null): string {
  if (usage === null) {
    return "—";
  }
  return `${usage >= 100 ? Math.round(usage) : Math.round(usage * 10) / 10}%`;
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

function Total({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular text-foreground">
        {value}
      </span>
    </span>
  );
}

/**
 * The states a user must know about, and only those: a routine `sleeping`
 * server would be noise on every row, so normal states carry no tag.
 */
const STATUS_TONES: Record<string, string> = {
  stopped: "bg-warn/15 text-warn",
  zombie: "bg-critical/15 text-critical",
  dead: "bg-critical/15 text-critical",
};

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
    <Table className="table-fixed min-w-full">
      <TableHeader>
        <TableRow>
          <TableHead className="w-[68%] pl-0 pr-1 whitespace-normal lg:w-[54%] 2xl:w-[32%]">
            Process
          </TableHead>
          <TableHead className="hidden w-[10%] text-right 2xl:table-cell">
            PID
          </TableHead>
          <TableHead className="hidden w-[14%] text-right 2xl:table-cell">
            Ports
          </TableHead>
          <TableHead className="hidden w-[8%] text-right 2xl:table-cell">
            CPU
          </TableHead>
          <TableHead
            className="w-[32%] px-1 text-right whitespace-normal lg:w-[26%] 2xl:w-[16%]"
            aria-label="Memory"
          >
            <span className="sm:hidden" aria-hidden="true">
              Mem
            </span>
            <span className="hidden sm:inline">Memory</span>
          </TableHead>
          <TableHead className="hidden w-[20%] pr-0 text-right lg:table-cell 2xl:w-[20%]">
            Uptime
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {group.processes.map((process) => (
          <TableRow
            key={process.pid}
            data-testid={`process-row-${process.pid}`}
          >
            <TableCell className="min-w-0 overflow-hidden pl-0 pr-1 whitespace-normal">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">
                    {process.name}
                  </span>
                  {process.status !== null && (
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-medium tracking-wide uppercase ${STATUS_TONES[process.status] ?? "bg-unknown/15 text-muted-foreground"}`}
                      data-testid={`process-status-${process.pid}`}
                    >
                      {process.status}
                    </span>
                  )}
                </span>
                {process.command !== null && (
                  <span className="truncate text-xs text-muted-foreground">
                    {process.command}
                  </span>
                )}
                <span
                  className="flex min-w-0 flex-wrap gap-x-2 text-xs text-muted-foreground 2xl:hidden"
                  data-testid={`process-details-${process.pid}`}
                >
                  <span>PID {process.pid}</span>
                  <span>Ports {compactEndpoints(group, process)}</span>
                  <span className="2xl:hidden">
                    CPU {formatCpu(process.cpuUsage)}
                  </span>
                  <span className="lg:hidden">
                    Uptime{" "}
                    {formatCountdown(uptimeMs(process, nowMs)) ?? "Unknown"}
                  </span>
                </span>
              </div>
            </TableCell>
            <TableCell className="hidden text-right text-xs tabular text-muted-foreground 2xl:table-cell">
              {process.pid}
            </TableCell>
            <TableCell
              className="hidden text-right text-xs tabular text-foreground 2xl:table-cell"
              data-testid={`process-ports-${process.pid}`}
            >
              {rowEndpoints(group, process)}
            </TableCell>
            <TableCell
              className="hidden text-right text-xs tabular text-foreground 2xl:table-cell"
              data-testid={`process-cpu-${process.pid}`}
            >
              {formatCpu(process.cpuUsage)}
            </TableCell>
            <TableCell
              className="px-1 text-right text-xs tabular text-foreground sm:text-sm"
              data-testid={`process-memory-${process.pid}`}
            >
              {process.memoryBytes === null
                ? "Unknown"
                : formatBytes(process.memoryBytes)}
            </TableCell>
            <TableCell
              className="hidden pr-0 text-right text-xs tabular text-foreground lg:table-cell sm:text-sm"
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

/**
 * The row's endpoints with their interfaces, from the group's scan — the
 * scan is where addresses live, so the per-row cells derive from it. An
 * unaskable scan renders its dash rather than borrowing an answered-empty
 * form.
 */
function rowEndpoints(group: Ipc.ProcessGroup, process: Ipc.ProcessSummary) {
  if (group.ports.state !== "checked") {
    return "—";
  }
  const endpoints = listeningEndpoints(group, process);
  return endpoints.length > 0 ? endpoints.join(" ") : "—";
}

function compactEndpoints(
  group: Ipc.ProcessGroup,
  process: Ipc.ProcessSummary,
): string {
  if (group.ports.state !== "checked") {
    return "Unavailable";
  }
  const endpoints = listeningEndpoints(group, process);
  return endpoints.length > 0 ? endpoints.join(" ") : "None";
}

/** The process's listening endpoints, unique, interface included. */
function listeningEndpoints(
  group: Ipc.ProcessGroup,
  process: Ipc.ProcessSummary,
): string[] {
  if (group.ports.state !== "checked") {
    return [];
  }
  const endpoints = group.ports.listening
    .filter((entry) => entry.pid === process.pid)
    .map(formatEndpoint);
  return [...new Set(endpoints)].sort();
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
        <HardDrive
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
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
        <StorageRowView
          key={`${row.label}-${row.path}`}
          row={row}
          group={group}
          withShareBar
        />
      ))}
      {group.storage.externalRows.length > 0 && (
        <div
          className="mt-1 flex flex-col gap-2"
          data-testid={`process-storage-external-${group.id}`}
        >
          <span className="text-xs font-medium text-muted-foreground">
            Outside the data directory
          </span>
          <p className="text-xs text-muted-foreground/70">
            Stored elsewhere through the tool's own environment settings; not
            part of the total above.
          </p>
          {group.storage.externalRows.map((row) => (
            <StorageRowView
              key={`${row.label}-${row.path}`}
              row={row}
              group={group}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StorageRowView({
  row,
  group,
  withShareBar = false,
}: {
  readonly row: Ipc.StorageRow;
  readonly group: Ipc.ProcessGroup;
  readonly withShareBar?: boolean;
}) {
  const totalBytes =
    group.storage.state === "measured" ? group.storage.totalBytes : 0;
  const share =
    totalBytes > 0
      ? Math.min(100, Math.max(0, (row.bytes / totalBytes) * 100))
      : 0;

  return (
    <div
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3"
      data-testid={`process-storage-row-${group.id}`}
    >
      <span className="min-w-0 max-w-[70%] break-words text-sm text-muted-foreground">
        {row.label}
        <span
          className="ml-2 break-words text-xs text-muted-foreground/70"
          data-testid={`process-storage-path-${group.id}`}
        >
          {row.path}
        </span>
        {withShareBar && (
          <span
            className="mt-1.5 block h-1 max-w-48 overflow-hidden rounded-full bg-accent-glass"
            role="presentation"
          >
            <span
              className="block h-full rounded-full bg-chart-1"
              data-testid={`process-storage-share-${group.id}`}
              style={{ width: `${share}%` }}
            />
          </span>
        )}
      </span>
      <span
        className="shrink-0 whitespace-nowrap text-right text-sm tabular text-foreground"
        data-testid={`process-storage-value-${group.id}`}
      >
        {formatBytes(row.bytes)}
        <span className="ml-2 text-xs text-muted-foreground">
          {row.fileCount} files
        </span>
      </span>
    </div>
  );
}

/**
 * The whole-screen failure state: the read itself could not be made. The
 * reason is shown when one was carried, and the one action offered is
 * another read — the same refresh the panels offer, not a new capability.
 */
export function ProcessInsightsError({
  message,
  onRetry,
}: {
  readonly message: string | null;
  readonly onRetry: () => void;
}) {
  return (
    <section
      className={`${PANEL} flex flex-col gap-3`}
      data-testid="process-error"
    >
      <div className="flex items-center gap-3">
        <Warning className="size-4 shrink-0 text-critical" aria-hidden="true" />
        <span className="text-sm text-muted-foreground">
          {message === null
            ? "The process list could not be read."
            : `The process list could not be read: ${message}`}
        </span>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={onRetry}
        data-testid="retry-processes"
      >
        <ArrowClockwise aria-hidden="true" />
        Try again
      </Button>
    </section>
  );
}
