/**
 * One usage window: the label, a bar of what remains, and when it resets.
 *
 * Data honesty rules this component enforces, because they are easy to break
 * with a "simplification":
 *
 *  - a bar renders **remaining**, never used, so it cannot be inverted;
 *  - a missing reset time renders as an explicit unknown, not a blank;
 *  - the tone is always paired with text, never colour alone.
 */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import * as Ipc from "~/lib/ipc";
import { cn } from "~/lib/utils";
import {
  formatCountdown,
  formatUsed,
  millisUntilReset,
  toneFor,
  windowTitle,
} from "~/lib/usage";

interface UsageWindowRowProps {
  readonly label: string;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly durationMins: number | null;
  readonly resetsAt: number | null;
  readonly permission: string;
  readonly freshness: string;
  readonly nowMs: number;
}

const TONE_CLASSES: Record<string, string> = {
  healthy: "bg-ok text-ok-foreground",
  warning: "bg-warn text-warn-foreground",
  critical: "bg-critical text-critical-foreground",
  unknown: "bg-unknown text-unknown-foreground",
};

const TONE_TEXT: Record<string, string> = {
  healthy: "text-ok",
  warning: "text-warn",
  critical: "text-critical",
  unknown: "text-muted-foreground",
};

export function UsageWindowRow({
  label,
  usedPercent,
  remainingPercent,
  durationMins,
  resetsAt,
  permission,
  freshness,
  nowMs,
}: UsageWindowRowProps) {
  const tone = toneFor({ usedPercent, freshness, permission });
  const countdown = formatCountdown(millisUntilReset(resetsAt, nowMs));
  const unavailable = freshness === "unavailable";

  return (
    // Responsive: the label and the figure share a row that wraps rather than
    // truncating, so a 300px widget and a wide window both stay legible.
    <div className="flex flex-col gap-2" data-testid="window-bar-row">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-foreground">
          {windowTitle(label, durationMins)}
        </span>
        <span
          className={cn(
            "tabular text-xs font-medium",
            unavailable ? "text-muted-foreground" : TONE_TEXT[tone],
          )}
        >
          {/* An unavailable window states why rather than showing a number. */}
          {unavailable ? "Not available" : formatUsed(usedPercent)}
        </span>
      </div>

      <div
        role="progressbar"
        aria-label={`${windowTitle(label, durationMins)} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={unavailable ? undefined : remainingPercent}
        aria-valuetext={
          unavailable ? "Not available" : `${remainingPercent}% remaining`
        }
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          data-testid="window-bar"
          data-tone={tone}
          className={cn(
            "h-full rounded-full transition-[width] duration-500 ease-out",
            TONE_CLASSES[tone],
          )}
          style={{
            // A genuinely dynamic value: the measured percentage cannot be
            // expressed as a Tailwind utility.
            width: unavailable ? "0%" : `${remainingPercent}%`,
          }}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="tabular">
          {unavailable ? "—" : `${remainingPercent}% left`}
        </span>
        <span className="tabular" data-testid="window-reset">
          {countdown === null ? "Reset time unknown" : `Resets in ${countdown}`}
        </span>
      </div>
    </div>
  );
}

/** The loading state for a window row, so the first paint is not a blank. */
export function UsageWindowSkeleton() {
  return (
    <div className="flex flex-col gap-2" data-testid="window-skeleton">
      <div className="h-4 w-28 animate-pulse rounded bg-muted" />
      <div className="h-2 w-full animate-pulse rounded-full bg-muted" />
      <div className="h-3 w-40 animate-pulse rounded bg-muted" />
    </div>
  );
}

/** The failure state. Always names a cause; never an empty bar. */
export function UsageWindowUnavailable({
  message,
}: {
  readonly message: string;
}) {
  return (
    <div
      data-testid="window-unavailable"
      className="flex flex-col gap-1 rounded-lg border border-dashed border-border bg-muted/40 p-3"
    >
      <span className="text-sm font-medium text-foreground">
        Usage not available
      </span>
      <span className="text-xs text-muted-foreground">{message}</span>
    </div>
  );
}

interface UsageWindowListProps {
  readonly result: AsyncResult.AsyncResult<Ipc.UsageSnapshot, unknown>;
  readonly nowMs: number;
}

/** Renders every window of one provider, matching all three result states. */
export function UsageWindowList({ result, nowMs }: UsageWindowListProps) {
  return AsyncResult.match(result, {
    onInitial: () => <UsageWindowSkeleton />,
    onSuccess: (success) => {
      const snapshot = success.value;
      return snapshot.freshness === "unavailable" ? (
        <UsageWindowUnavailable
          message={snapshot.reason ?? "No reason was reported."}
        />
      ) : (
        <div className="flex flex-col gap-5">
          {snapshot.windows.map((window) => (
            <UsageWindowRow
              key={window.label}
              label={window.label}
              usedPercent={window.usedPercent}
              remainingPercent={window.remainingPercent}
              durationMins={window.durationMins}
              resetsAt={window.resetsAt}
              permission={snapshot.permission}
              freshness={snapshot.freshness}
              nowMs={nowMs}
            />
          ))}
        </div>
      );
    },
    onFailure: () => (
      <UsageWindowUnavailable message="The app could not be reached." />
    ),
  });
}