/**
 * Stats: every window, with exact figures and provenance.
 *
 * Home answers "can I keep working"; this view is the ledger — the precise
 * numbers, absolute reset times, and where each reading came from. Deliberately
 * different presentation from Home's bars: a row per fact, so a value can be
 * read exactly rather than estimated off a bar.
 *
 * Owns the `stats-*` testids. It must not re-render `window-bar` — Home owns
 * that testid, and both views stay mounted, so a duplicate would make every
 * spec selector ambiguous.
 */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";

import { usageAtom } from "~/atoms";
import { PANEL, PanelHeader } from "~/components/dashboard/panel";
import type * as Ipc from "~/lib/ipc";
import { safeResetAt, windowTitle } from "~/lib/usage";

export function StatsView({ visible }: { readonly visible: boolean }) {
  const usage = useAtomValue(usageAtom);
  const refreshUsage = useAtomRefresh(usageAtom);

  return (
    <div className={visible ? "block" : "hidden"} data-testid="view-stats">
      <header className="flex flex-col gap-1">
        <h1 className="text-[clamp(1.25rem,4vw,1.5rem)] font-semibold tracking-tight text-foreground">
          Stats
        </h1>
        <p className="text-sm text-muted-foreground">
          Every window, with what remains in each.
        </p>
      </header>

      <section className={PANEL} data-testid="stats-panel">
        <PanelHeader
          title="Windows"
          testId="stats-refresh"
          onRefresh={refreshUsage}
        />

        {AsyncResult.match(usage, {
          onInitial: () => (
            <p
              className="text-sm text-muted-foreground"
              data-testid="stats-loading"
            >
              Reading your usage…
            </p>
          ),
          onSuccess: (result) => {
            const codex = result.value.find(
              (snapshot) => snapshot.provider === "codex",
            );
            if (!codex) {
              return (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="stats-empty"
                >
                  No provider reported any usage.
                </p>
              );
            }

            if (codex.freshness === "unavailable") {
              return (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="stats-unavailable"
                >
                  {codex.reason ?? "No reading is available right now."}
                </p>
              );
            }

            return (
              <div className="flex flex-col gap-5" data-testid="stats-windows">
                {codex.windows.map((window) => (
                  <StatsRow
                    key={window.label}
                    label={window.label}
                    durationMins={window.durationMins}
                    usedPercent={window.usedPercent}
                    remainingPercent={window.remainingPercent}
                    resetsAt={safeResetAt(window.resetsAt)}
                  />
                ))}
              </div>
            );
          },
          onFailure: () => (
            <p className="text-sm text-destructive" data-testid="stats-error">
              The app could not be reached.
            </p>
          ),
        })}
      </section>

      <Provenance snapshot={AsyncResult.match(usage, {
        onInitial: () => null,
        onSuccess: (result) =>
          result.value.find((snapshot) => snapshot.provider === "codex") ??
          null,
        onFailure: () => null,
      })} />
    </div>
  );
}

function StatsRow({
  label,
  durationMins,
  usedPercent,
  remainingPercent,
  resetsAt,
}: {
  readonly label: string;
  readonly durationMins: number | null;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly resetsAt: number | null;
}) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="stats-window-row">
      <p className="text-sm font-medium text-foreground">
        {windowTitle(label, durationMins)}
      </p>
      <Fact label="Used" testId="stats-used" value={`${usedPercent}%`} />
      <Fact
        label="Remaining"
        testId="stats-remaining"
        value={`${remainingPercent}%`}
      />
      <Fact
        label="Resets at"
        testId="stats-reset-at"
        value={resetsAt !== null ? formatAbsolute(resetsAt) : "—"}
      />
    </div>
  );
}

function Fact({
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

/**
 * Provenance: where the numbers came from and when.
 *
 * A number without its provenance reads as more certain than it is, so the
 * source and the read time are part of this view rather than a footnote.
 */
function Provenance({
  snapshot,
}: {
  readonly snapshot: Ipc.UsageSnapshot | null;
}) {
  return (
    <div
      className="flex flex-col gap-1 text-xs text-muted-foreground"
      data-testid="stats-provenance"
    >
      <p>
        Source: <span data-testid="stats-source">{snapshot?.source ?? "—"}</span>
      </p>
      <p>
        Read:{" "}
        <span className="tabular" data-testid="stats-fetched-at">
          {snapshot?.fetchedAt != null ? formatAbsolute(snapshot.fetchedAt) : "—"}
        </span>
      </p>
    </div>
  );
}

function formatAbsolute(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}
