/**
 * One connection's scheduled-kickoff controls.
 *
 * The model can be chosen independently, but the switch starts off and no
 * prompt is scheduled until the user opts in. The copy distinguishes the
 * reported-reset schedule from a verified rollover and states the quota cost.
 *
 * Writes go through the command and then refresh the atom the section reads,
 * so the toggle, the picker, and the schedule on disk cannot disagree.
 */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Effect from "effect/Effect";
import { useState, type ReactElement } from "react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";

import { kickoffAtom, kickoffViewOf } from "~/atoms";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import * as Ipc from "~/lib/ipc";
import { formatCountdown } from "~/lib/usage";

export function KickoffSection({
  kind,
  nowMs,
}: {
  readonly kind: Ipc.ProviderKind;
  readonly nowMs: number;
}): ReactElement | null {
  const overview = useAtomValue(kickoffAtom);
  const refreshOverview = useAtomRefresh(kickoffAtom);
  const [error, setError] = useState<string | null>(null);

  const apply = (
    write: () => Effect.Effect<Ipc.KickoffOverview, Ipc.AppError>,
  ) => {
    void Effect.runPromise(write())
      .then(() => {
        setError(null);
        refreshOverview();
      })
      .catch((cause: unknown) => {
        setError(describe(cause));
        refreshOverview();
      });
  };

  return AsyncResult.match(overview, {
    onInitial: () => null,
    onFailure: () => (
      <p
        className="text-xs text-muted-foreground"
        data-testid={`kickoff-unavailable-${kind}`}
      >
        The kickoff schedule could not be read.
      </p>
    ),
    onSuccess: (result) => {
      const view = kickoffViewOf(result.value, kind);
      if (view === null) return null;
      return (
        <KickoffControls
          view={view}
          scheduler={result.value.scheduler}
          nowMs={nowMs}
          error={error}
          onToggle={(enabled) => apply(() => Ipc.setKickoffEnabled(kind, enabled))}
          onModel={(modelId) => apply(() => Ipc.setKickoffModel(kind, modelId))}
        />
      );
    },
  });
}

function KickoffControls({
  view,
  scheduler,
  nowMs,
  error,
  onToggle,
  onModel,
}: {
  readonly view: Ipc.KickoffView;
  readonly scheduler: Ipc.SchedulerStatus;
  readonly nowMs: number;
  readonly error: string | null;
  readonly onToggle: (enabled: boolean) => void;
  readonly onModel: (modelId: string) => void;
}): ReactElement {
  return (
    <div
      className="flex flex-col gap-3"
      data-testid={`kickoff-section-${view.kind}`}
    >
      <span className="text-xs font-medium text-muted-foreground">
        Scheduled kickoff
      </span>

      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <label
            htmlFor={`kickoff-toggle-${view.kind}`}
            className="text-sm font-medium"
          >
            Enable scheduled “Hi”
          </label>
          <p
            className="max-w-prose text-xs leading-relaxed text-muted-foreground"
            data-testid={`kickoff-copy-${view.kind}`}
          >
            Uses the latest reported reset time for this connection. When that
            time is in the future, one “Hi” is scheduled about a minute later;
            without a future reset, the first attempt may be immediate. This
            build does not verify a rollover before sending. A “Hi” uses quota
            and does not create, reset, or extend a usage window.
          </p>
        </div>
        <Switch
          id={`kickoff-toggle-${view.kind}`}
          checked={view.enabled}
          onCheckedChange={onToggle}
          data-testid={`kickoff-toggle-${view.kind}`}
          aria-label={`Enable scheduled Hi for ${view.kind}`}
        />
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">Model for “Hi”</span>
          <Select value={view.effectiveModel} onValueChange={onModel}>
            <SelectTrigger
              className="w-56"
              data-testid={`kickoff-model-${view.kind}`}
              aria-label={`Kickoff model for ${view.kind}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {view.models.map((model) => (
                <SelectItem
                  key={model.id}
                  value={model.id}
                  data-testid={`kickoff-model-option-${view.kind}-${model.id}`}
                >
                  {model.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p
          className="text-xs leading-relaxed text-muted-foreground"
          data-testid={`kickoff-model-note-${view.kind}`}
        >
          This catalog is not live-verified by the connection; model availability
          and quota impact are unknown.
        </p>

        {view.enabled && (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                Next scheduled “Hi”
              </span>
              <span
                className="text-sm tabular"
                data-testid={`kickoff-next-${view.kind}`}
              >
                {formatNextKick(view.nextKickAt, nowMs)}
              </span>
            </div>

            {view.lastAccepted !== null && (
              <p
                className={
                  view.lastAccepted ? "text-xs text-ok" : "text-xs text-critical"
                }
                data-testid={`kickoff-last-${view.kind}`}
              >
                Last attempt {view.lastAccepted ? "succeeded" : "failed"}
                {view.lastDetail ? `: ${view.lastDetail}` : ""}
              </p>
            )}
          </>
        )}
      </div>

      {view.enabled && !scheduler.supported && (
        <p
          className="text-xs text-warn"
          data-testid={`kickoff-unsupported-${view.kind}`}
        >
          Background scheduling is not supported on this platform yet.
        </p>
      )}
      {view.enabled && scheduler.supported && !scheduler.installed && (
        <p
          className="text-xs text-warn"
          data-testid={`kickoff-scheduler-warn-${view.kind}`}
        >
          The background scheduler is not installed, so the kickoff only runs
          while AgentGauge is open.
        </p>
      )}

      {error !== null && (
        <p
          className="text-xs text-destructive"
          data-testid={`kickoff-error-${view.kind}`}
        >
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * "in 1h 24m · 14:32", or "due now" when the schedule passed and the
 * background worker has not fired yet — it polls about once a minute, so a
 * past time is imminent rather than broken.
 */
function formatNextKick(nextKickAt: number | null, nowMs: number): string {
  if (nextKickAt === null || !Number.isFinite(nextKickAt)) return "—";
  const millis = nextKickAt - nowMs;
  if (millis <= 0) return "due now";
  return `in ${formatCountdown(millis) ?? "—"} · ${formatTime(nextKickAt)}`;
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The reason a kickoff write failed, phrased for the user — the same rule as
 * the usage tab's failure line.
 */
function describe(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  if (typeof cause === "string" && cause.length > 0) return cause;
  return "The kickoff could not be saved.";
}

/** Exported for unit tests of the countdown phrasing. */
export { formatNextKick };
