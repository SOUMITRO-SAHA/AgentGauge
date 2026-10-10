/** Read-only CLI installation checks; detection does not imply usage support. */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { ArrowClockwise, CheckCircle, Terminal, Warning } from "@phosphor-icons/react";

import { cliDetectionAtom } from "~/atoms";
import { PANEL } from "~/components/dashboard/panel";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import type * as Ipc from "~/lib/ipc";

const INSTALL_COMMANDS: Record<Ipc.CliToolStatus["tool"], string> = {
  codex: "npm install -g @openai/codex",
  openCode: "npm install -g opencode-ai",
};

export function ProviderStatusCard() {
  const result = useAtomValue(cliDetectionAtom);
  const refresh = useAtomRefresh(cliDetectionAtom);

  return (
    <section
      data-testid="provider-status"
      aria-label="CLI detection"
      className={`relative ${PANEL}`}
    >
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2 size-7 text-muted-foreground hover:text-foreground"
        onClick={() => refresh()}
        data-testid="refresh-provider"
        aria-label="Re-check installed CLIs"
      >
        <ArrowClockwise aria-hidden="true" />
      </Button>
      <div className="flex flex-col gap-4 pr-8">
        <h2 className="font-display text-sm font-semibold text-foreground">CLI detection</h2>
        {AsyncResult.match(result, {
          onInitial: () => (
            <div className="flex flex-col gap-3" data-testid="status-loading">
              <div className="h-4 w-40 animate-pulse rounded bg-muted" />
              <div className="h-4 w-40 animate-pulse rounded bg-muted" />
            </div>
          ),
          onSuccess: (success) => (
            <div className="flex flex-col gap-3">
              {success.value.map((tool) => (
                <CliStatusRow key={tool.tool} status={tool} />
              ))}
              <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
                AgentGauge currently reads usage from Codex only. Detecting
                another CLI does not enable its usage integration.
              </p>
            </div>
          ),
          onFailure: () => (
            <div className="flex items-center gap-3" data-testid="status-error">
              <Warning className="size-4 text-critical" aria-hidden="true" />
              <span className="text-sm text-muted-foreground">
                The app could not check installed CLIs.
              </span>
            </div>
          ),
        })}
      </div>
    </section>
  );
}

function CliStatusRow({ status }: { readonly status: Ipc.CliToolStatus }) {
  return (
    <div
      className="flex min-w-0 items-start gap-3"
      data-testid={`cli-${status.tool === "openCode" ? "opencode" : "codex"}`}
    >
      {status.installed ? (
        <CheckCircle className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden="true" />
      ) : (
        <Warning className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
      )}
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-medium text-foreground">
          {status.installed
            ? `${status.displayName} detected`
            : `${status.displayName} not found`}
        </span>
        {status.installed ? (
          <span
            className="break-words text-xs text-muted-foreground"
            data-testid={`${status.tool === "openCode" ? "opencode" : "codex"}-version`}
          >
            {status.version ?? "Version unknown"}
          </span>
        ) : (
          <>
            <span className="text-xs text-muted-foreground">
              {status.reason ?? "The executable was not found on your PATH."}
            </span>
            <code className="inline-flex max-w-full items-center gap-1.5 self-start overflow-x-auto rounded-md bg-muted px-2 py-1 text-xs whitespace-nowrap text-foreground">
              <Terminal className="size-3 shrink-0" aria-hidden="true" />
              {INSTALL_COMMANDS[status.tool]}
            </code>
          </>
        )}
      </div>
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
