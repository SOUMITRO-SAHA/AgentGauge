/**
 * Whether the Codex CLI is installed, with the fix when it is not.
 *
 * The onboarding flow gates on this rather than on a guess, so a user without
 * Codex is told exactly what to install instead of being shown an empty
 * dashboard.
 */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useAtomValue } from "@effect/atom-react";
import { Terminal, CircleCheck, TriangleAlert } from "lucide-react";

import { providerStatusAtom } from "~/atoms";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export function ProviderStatusCard() {
  const result = useAtomValue(providerStatusAtom);

  return (
    <div
      data-testid="provider-status"
      className="rounded-xl border border-border/70 bg-surface-raised/70 p-[clamp(0.75rem,2.5vw,1.25rem)] backdrop-blur-md"
    >
      {AsyncResult.match(result, {
        onInitial: () => (
          <div className="flex items-center gap-3" data-testid="status-loading">
            <div className="size-8 animate-pulse rounded-lg bg-muted" />
            <div className="h-4 w-40 animate-pulse rounded bg-muted" />
          </div>
        ),
        onSuccess: (result) => {
          const codex = result.value.find(
            (provider) => provider.kind === "codex",
          );

          if (!codex) {
            return (
              <div className="flex items-center gap-3" data-testid="status-unknown">
                <TriangleAlert className="size-4 text-unknown" aria-hidden="true" />
                <span className="text-sm text-muted-foreground">
                  No provider is registered.
                </span>
              </div>
            );
          }

          return (
            <div className="flex items-start gap-3">
              {codex.installed ? (
                <CircleCheck
                  className="mt-0.5 size-4 shrink-0 text-ok"
                  aria-hidden="true"
                />
              ) : (
                <TriangleAlert
                  className="mt-0.5 size-4 shrink-0 text-warn"
                  aria-hidden="true"
                />
              )}

              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium text-foreground">
                  {codex.installed ? "Codex CLI detected" : "Codex CLI not found"}
                </span>

                {codex.installed ? (
                  <span
                    className="tabular text-xs text-muted-foreground"
                    data-testid="codex-version"
                  >
                    {codex.version ?? "Version unknown"}
                  </span>
                ) : (
                  <>
                    <span className="text-xs text-muted-foreground">
                      {codex.reason ?? "The executable was not found on your PATH."}
                    </span>
                    <code className="mt-1 inline-flex max-w-full items-center gap-1.5 self-start overflow-x-auto rounded-md bg-muted px-2 py-1 text-xs whitespace-nowrap text-foreground">
                      <Terminal className="size-3 shrink-0" aria-hidden="true" />
                      npm install -g @openai/codex
                    </code>
                  </>
                )}
              </div>
            </div>
          );
        },
        onFailure: () => (
          <div className="flex items-center gap-3" data-testid="status-error">
            <TriangleAlert className="size-4 text-critical" aria-hidden="true" />
            <span className="text-sm text-muted-foreground">
              The app could not be reached.
            </span>
          </div>
        ),
      })}
    </div>
  );
}

/** A compact freshness pill: never colour alone, always with text. */
export function FreshnessPill({
  freshness,
  label,
  className,
}: {
  readonly freshness: string;
  readonly label: string;
  readonly className?: string;
}) {
  const tone =
    freshness === "live"
      ? "bg-ok/15 text-ok"
      : freshness === "stale"
        ? "bg-warn/15 text-warn"
        : "bg-unknown/15 text-muted-foreground";

  return (
    <span
      data-testid="freshness-pill"
      data-freshness={freshness}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        tone,
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}

/** A primary action that reports its own pending state. */
export function ActionButton({
  label,
  pending,
  onClick,
  testId,
}: {
  readonly label: string;
  readonly pending: boolean;
  readonly onClick: () => void;
  readonly testId: string;
}) {
  return (
    <Button onClick={onClick} disabled={pending} data-testid={testId}>
      {pending ? "Working…" : label}
    </Button>
  );
}