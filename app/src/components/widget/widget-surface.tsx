/**
 * The widget surface.
 *
 * The same bundle as the app, loaded with `?surface=widget` into a frameless,
 * always-on-top window. It is a separate route rather than a second build so
 * the widget and the app can never disagree about how a reading is rendered.
 */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useAtomValue } from "@effect/atom-react";

import { usageAtom } from "~/atoms";
import { UsageWindowRow } from "~/components/usage/usage-window-row";
import { useClock } from "~/hooks/use-clock";
import { formatCountdown, millisUntilReset } from "~/lib/usage";

export function WidgetSurface() {
  const usage = useAtomValue(usageAtom);
  const nowMs = useClock();

  return (
    <div
      // The widget is a small always-on-top window, so this is sized in
      // viewport units: the reading scales with however large the user drags
      // it, without a breakpoint or a fixed width anywhere.
      className="flex h-full flex-col gap-[clamp(0.375rem,2vh,0.75rem)] p-[clamp(0.5rem,4%,1rem)]"
      data-testid="widget"
      data-surface="widget"
    >
      <header className="flex shrink-0 items-center justify-between gap-2">
        <span className="text-[clamp(0.625rem,2.5vh,0.75rem)] font-semibold uppercase tracking-wide text-muted-foreground">
          Codex
        </span>
        <span className="size-1.5 shrink-0 rounded-full bg-ok" aria-hidden="true" />
      </header>

      {AsyncResult.match(usage, {
        onInitial: () => (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-xs text-muted-foreground">Reading…</p>
          </div>
        ),
        onSuccess: (result) => {
          const codex = result.value.find(
            (snapshot) => snapshot.provider === "codex",
          );
          const fiveHour = codex?.fiveHour;

          if (!codex || codex.freshness === "unavailable" || !fiveHour) {
            return (
              <div
                className="flex flex-1 flex-col items-center justify-center gap-1 text-center"
                data-testid="widget-unavailable"
              >
                <span className="text-sm font-medium text-foreground">
                  Not available
                </span>
                <span className="text-xs text-muted-foreground">
                  {codex?.reason ?? "No usage was reported."}
                </span>
              </div>
            );
          }

          const countdown = formatCountdown(millisUntilReset(fiveHour.resetsAt, nowMs));

          return (
            <div className="flex min-h-0 flex-1 flex-col justify-center gap-[clamp(0.25rem,1.5vh,0.5rem)]">
              <div className="flex items-baseline gap-1.5">
                <span
                  className="tabular text-[clamp(1.75rem,12vh,3rem)] font-semibold tracking-tight text-foreground"
                  data-testid="widget-remaining"
                >
                  {fiveHour.remainingPercent}
                </span>
                <span className="text-[clamp(0.75rem,3vh,0.875rem)] text-muted-foreground">
                  % left
                </span>
              </div>

              <UsageWindowRow
                label={fiveHour.label}
                usedPercent={fiveHour.usedPercent}
                remainingPercent={fiveHour.remainingPercent}
                durationMins={fiveHour.durationMins}
                resetsAt={fiveHour.resetsAt}
                permission={codex.permission}
                freshness={codex.freshness}
                nowMs={nowMs}
              />

              <p
                className="tabular shrink-0 text-[clamp(0.625rem,2.5vh,0.75rem)] text-muted-foreground"
                data-testid="widget-reset"
              >
                {countdown === null ? "Reset time unknown" : `Resets in ${countdown}`}
              </p>
            </div>
          );
        },
        onFailure: () => (
          <div
            className="flex flex-1 flex-col items-center justify-center gap-1 text-center"
            data-testid="widget-error"
          >
            <span className="text-sm font-medium text-foreground">
              Not available
            </span>
            <span className="text-xs text-muted-foreground">
              The app could not be reached.
            </span>
          </div>
        ),
      })}
    </div>
  );
}