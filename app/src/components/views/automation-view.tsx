/**
 * Automation: send "Hi" at every reset + 1 minute.
 *
 * One card per connection. The user picks a model and effort (defaulting to
 * the cheapest), clicks Start, and the app monitors resets AND sends "Hi"
 * after each one. A single Start/Stop button controls both the monitor and
 * the kickoff schedule. The equivalent CLI command is displayed for
 * transparency.
 */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Effect from "effect/Effect";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Check, Copy, Play, Stop } from "@phosphor-icons/react";
import { enable as enableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";

import {
  automationAtom,
  kickoffAtom,
  kickoffViewOf,
  subscriptionsAtom,
} from "~/atoms";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "~/components/ui/tooltip";
import { ViewHeader } from "~/components/views/view-header";
import { PANEL } from "~/components/dashboard/panel";
import { useClock } from "~/hooks/use-clock";
import * as Ipc from "~/lib/ipc";
import { tabsFrom, formatCountdown, type UsageTab } from "~/lib/usage";

export function AutomationView({ visible }: { readonly visible: boolean }) {
  const [selectedTab, setSelectedTab] = useState<string | null>(null);
  const automation = useAtomValue(automationAtom);
  const kickoff = useAtomValue(kickoffAtom);
  const refreshAutomation = useAtomRefresh(automationAtom);
  const refreshKickoff = useAtomRefresh(kickoffAtom);
  const subscriptions = useAtomValue(subscriptionsAtom);
  const nowMs = useClock();

  useEffect(() => {
    if (visible) {
      refreshAutomation();
      refreshKickoff();
    }
  }, [visible, refreshAutomation, refreshKickoff]);

  const tabs = tabsFrom(
    AsyncResult.match(subscriptions, {
      onInitial: () => [],
      onSuccess: (result) => result.value,
      onFailure: () => [],
    }),
  ).filter(
    (tab): tab is UsageTab & { kind: NonNullable<UsageTab["kind"]> } =>
      tab.kind !== null,
  );

  return (
    <div
      className={visible ? "flex flex-col gap-4" : "hidden"}
      data-testid="view-automation"
    >
      <ViewHeader
        title="Automation"
        subtitle="Send a minimal &ldquo;Hi&rdquo; after every reported reset to start your usage window."
      />

      {AsyncResult.match(automation, {
        onInitial: () => <AutomationLoadingSkeleton />,
        onFailure: () => (
          <p className="text-sm text-destructive" data-testid="automation-error">
            The app could not be reached.
          </p>
        ),
        onSuccess: (result) => {
          if (tabs.length === 0) {
            return (
              <p className="text-sm text-muted-foreground">
                No readable connections are available for automation.
              </p>
            );
          }

          const connections = tabs.map((tab) => {
            const monitor =
              result.value.find((item) => item.kind === tab.kind) ?? null;
            const view = AsyncResult.match(kickoff, {
              onInitial: () => null,
              onSuccess: (ko) => kickoffViewOf(ko.value, tab.kind),
              onFailure: () => null,
            });
            const running = monitor?.running ?? false;
            const enabled = view?.enabled ?? false;

            return {
              tab,
              monitor,
              view,
              isActive: running && enabled,
            };
          });

          const activeTab =
            tabs.find((tab) => tab.value === selectedTab)?.value ??
            tabs[0].value;

          return (
            <Tabs
              value={activeTab}
              onValueChange={setSelectedTab}
              className="flex flex-col gap-4"
              data-testid="automation-connections"
            >
              <TabsList
                aria-label="Automation connections"
                className="!grid !h-auto w-full grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-1 rounded-lg border border-border/70 bg-surface-raised/60 p-1"
              >
                {connections.map(({ tab, isActive }) => (
                  <TabsTrigger
                    key={tab.value}
                    value={tab.value}
                    className="!h-auto min-w-0 flex-col items-start gap-1 px-3 py-2 text-left whitespace-normal"
                    data-testid={`automation-connection-tab-${tab.kind}`}
                  >
                    <span className="max-w-full break-words">{tab.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {isActive ? "Active" : "Inactive"}
                    </span>
                  </TabsTrigger>
                ))}
              </TabsList>

              {connections.map(({ tab, monitor, view }) => (
                <TabsContent
                  key={tab.value}
                  value={tab.value}
                  className="mt-0"
                >
                  <ConnectionCard
                    tab={tab}
                    monitor={monitor}
                    view={view}
                    onChanged={() => {
                      refreshAutomation();
                      refreshKickoff();
                    }}
                    nowMs={nowMs}
                  />
                </TabsContent>
              ))}
            </Tabs>
          );
        },
      })}

      <p className="text-xs leading-relaxed text-muted-foreground">
        A "Hi" uses quota and does not create, reset, or extend a usage
        window. Your automation choices are remembered across restarts.
      </p>
    </div>
  );
}

function AutomationLoadingSkeleton() {
  return (
    <section className={PANEL} data-testid="automation-loading">
      <div
        className="flex flex-col gap-4"
        data-testid="automation-loading-skeleton"
        role="status"
        aria-label="Loading automation settings"
      >
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-4 w-36" aria-hidden="true" />
          <Skeleton className="size-8" aria-hidden="true" />
        </div>
        <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Skeleton className="h-4 w-28" aria-hidden="true" />
            <Skeleton
              className="h-9 w-full max-w-56 rounded-md"
              aria-hidden="true"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Skeleton className="h-4 w-24" aria-hidden="true" />
            <Skeleton
              className="h-9 w-full max-w-56 rounded-md"
              aria-hidden="true"
            />
          </div>
        </div>
        <Skeleton className="h-12 w-full rounded-md" aria-hidden="true" />
        <Skeleton className="h-8 w-32 rounded-md" aria-hidden="true" />
      </div>
    </section>
  );
}

function ConnectionCard({
  tab,
  monitor,
  view,
  onChanged,
  nowMs,
}: {
  readonly tab: UsageTab & { kind: NonNullable<UsageTab["kind"]> };
  readonly monitor: Ipc.AutomationState | null;
  readonly view: Ipc.KickoffView | null;
  readonly onChanged: () => void;
  readonly nowMs: number;
}): ReactElement {
  const kind = tab.kind;
  const running = monitor?.running ?? false;
  const enabled = view?.enabled ?? false;
  const isActive = running && enabled;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await Effect.runPromise(Ipc.startAutomation(kind));
      await Effect.runPromise(Ipc.setKickoffEnabled(kind, true));
      try {
        const alreadyEnabled = await isAutostartEnabled();
        if (!alreadyEnabled) await enableAutostart();
      } catch {
        // Autostart is best-effort; the automation itself matters more.
      }
      onChanged();
    } catch (cause: unknown) {
      setError(describeError(cause));
      onChanged();
    } finally {
      setBusy(false);
    }
  }, [kind, onChanged]);

  const stop = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await Effect.runPromise(Ipc.setKickoffEnabled(kind, false));
      await Effect.runPromise(Ipc.stopAutomation(kind));
      onChanged();
    } catch (cause: unknown) {
      setError(describeError(cause));
      onChanged();
    } finally {
      setBusy(false);
    }
  }, [kind, onChanged]);

  const applyModel = useCallback(
    (modelId: string) => {
      void Effect.runPromise(Ipc.setKickoffModel(kind, modelId))
        .then(() => {
          setError(null);
          onChanged();
        })
        .catch((cause: unknown) => {
          setError(describeError(cause));
          onChanged();
        });
    },
    [kind, onChanged],
  );

  const applyEffort = useCallback(
    (effortId: string) => {
      void Effect.runPromise(Ipc.setKickoffEffort(kind, effortId))
        .then(() => {
          setError(null);
          onChanged();
        })
        .catch((cause: unknown) => {
          setError(describeError(cause));
          onChanged();
        });
    },
    [kind, onChanged],
  );

  return (
    <TooltipProvider>
      <section className={PANEL} data-testid={`automation-panel-${kind}`}>
        <h2 className="mb-4 truncate font-display text-sm font-semibold text-foreground">
          {tab.label}
        </h2>

        {view === null ? (
          <p className="text-sm text-muted-foreground">
            Automation is unavailable for this connection.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <ModelEffortPicker
              view={view}
              isActive={isActive}
              onModel={applyModel}
              onEffort={applyEffort}
            />

            <CommandPreview kind={kind} view={view} />

            <Button
              className="w-full"
              variant={isActive ? "destructive" : "default"}
              size="lg"
              disabled={busy || (!isActive && view.models.length === 0)}
              onClick={isActive ? stop : start}
              data-testid={`automation-toggle-${kind}`}
              aria-pressed={isActive}
              aria-label={`${isActive ? "Stop" : "Start"} automation for ${kind}`}
            >
              {isActive ? (
                <>
                  <Stop aria-hidden="true" weight="fill" />
                  Stop Automation
                </>
              ) : (
                <>
                  <Play aria-hidden="true" weight="fill" />
                  Start Automation
                </>
              )}
            </Button>

            {isActive && (
              <StatusSection
                kind={kind}
                view={view}
                monitor={monitor}
                nowMs={nowMs}
              />
            )}

            <SchedulerWarning kind={kind} enabled={view.enabled} />

            {error !== null && (
              <p
                className="text-xs text-destructive"
                data-testid={`automation-error-${kind}`}
              >
                {error}
              </p>
            )}
          </div>
        )}
      </section>
    </TooltipProvider>
  );
}

function ModelEffortPicker({
  view,
  isActive,
  onModel,
  onEffort,
}: {
  readonly view: Ipc.KickoffView;
  readonly isActive: boolean;
  readonly onModel: (modelId: string) => void;
  readonly onEffort: (effortId: string) => void;
}) {
  const selectedModel = view.models.find(
    (model) => model.id === view.effectiveModel,
  );
  const efforts = selectedModel?.efforts ?? [];
  const lockedMessage =
    "Stop automation before changing model or effort.";

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">Model</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={isActive ? 0 : undefined}
              title={isActive ? lockedMessage : undefined}
            >
              <Select
                value={view.effectiveModel}
                onValueChange={onModel}
                disabled={isActive || view.models.length === 0}
              >
                <SelectTrigger
                  className="w-56"
                  data-testid={`kickoff-model-${view.kind}`}
                  aria-label={`Kickoff model for ${view.kind}`}
                >
                  <SelectValue placeholder="Unavailable" />
                </SelectTrigger>
                <SelectContent position="popper">
                  {view.models.map((model) => (
                    <SelectItem
                      key={model.id}
                      value={model.id}
                      data-testid={`kickoff-model-option-${view.kind}-${model.id}`}
                    >
                      {model.label}
                      {model.cheapest && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          (cheapest)
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </span>
          </TooltipTrigger>
          {isActive && (
            <TooltipContent data-testid={`kickoff-model-locked-tooltip-${view.kind}`}>
              {lockedMessage}
            </TooltipContent>
          )}
        </Tooltip>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">Effort</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={isActive ? 0 : undefined}
              title={isActive ? lockedMessage : undefined}
            >
              <Select
                value={view.effortId ?? efforts[0]?.id ?? ""}
                onValueChange={onEffort}
                disabled={isActive || efforts.length === 0}
              >
                <SelectTrigger
                  className="w-56"
                  data-testid={`kickoff-effort-${view.kind}`}
                  aria-label={`Kickoff effort for ${view.kind}`}
                >
                  <SelectValue placeholder="Unavailable" />
                </SelectTrigger>
                <SelectContent position="popper">
                  {efforts.map((effort) => (
                    <SelectItem
                      key={effort.id}
                      value={effort.id}
                      data-testid={`kickoff-effort-option-${view.kind}-${effort.id}`}
                    >
                      {effort.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </span>
          </TooltipTrigger>
          {isActive && (
            <TooltipContent data-testid={`kickoff-effort-locked-tooltip-${view.kind}`}>
              {lockedMessage}
            </TooltipContent>
          )}
        </Tooltip>
      </div>

      {view.modelError != null && (
        <p
          className="text-xs text-warn"
          data-testid={`kickoff-model-error-${view.kind}`}
        >
          {view.modelError}
        </p>
      )}
    </div>
  );
}

const OPENCODE_PROVIDER_MAP: Record<string, string> = {
  zai: "zai-coding-plan",
  minimax: "minimax-coding-plan",
  kimi: "kimi-code-plan-global",
};

function buildCommand(
  kind: Ipc.ProviderKind,
  model: string,
  effort: string | undefined,
): string {
  if (kind === "codex") {
    const parts = [
      "codex",
      "exec",
      '"Hi"',
      "--model",
      model,
      "-s",
      "read-only",
    ];
    if (effort) {
      parts.push("-c", `'model_reasoning_effort="${effort}"'`);
    }
    parts.push("--ephemeral");
    return parts.join(" ");
  }

  const provider = OPENCODE_PROVIDER_MAP[kind] ?? kind;
  const parts = [
    "opencode",
    "run",
    '"Hi"',
    "-m",
    `${provider}/${model}`,
  ];
  if (effort) {
    parts.push("--variant", effort);
  }
  parts.push("--dir", "/tmp");
  return parts.join(" ");
}

function CommandPreview({
  kind,
  view,
}: {
  readonly kind: Ipc.ProviderKind;
  readonly view: Ipc.KickoffView;
}) {
  const [copied, setCopied] = useState(false);
  const command = buildCommand(
    kind,
    view.effectiveModel,
    view.effortId,
  );

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [command]);

  return (
    <div
      className="group relative rounded-md border border-border/60 bg-surface/60 p-3"
      data-testid={`automation-command-${kind}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <span className="mb-1 block text-xs text-muted-foreground">
            Command at each reset cycle
          </span>
          <code className="block break-all text-xs leading-relaxed text-foreground">
            {command}
          </code>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={copy}
              data-testid={`automation-copy-${kind}`}
              aria-label="Copy command"
            >
              {copied ? (
                <Check className="text-ok" aria-hidden="true" />
              ) : (
                <Copy aria-hidden="true" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function SchedulerWarning({
  kind,
  enabled,
}: {
  readonly kind: Ipc.ProviderKind;
  readonly enabled: boolean;
}) {
  const overview = useAtomValue(kickoffAtom);
  if (!enabled) return null;

  const scheduler = AsyncResult.match(overview, {
    onInitial: () => null,
    onSuccess: (ko) => ko.value.scheduler,
    onFailure: () => null,
  });

  if (scheduler === null) return null;

  if (!scheduler.supported) {
    return (
      <p
        className="text-xs text-warn"
        data-testid={`automation-unsupported-${kind}`}
      >
        Background scheduling is not supported on this platform yet.
      </p>
    );
  }

  if (!scheduler.installed) {
    return (
      <p
        className="text-xs text-warn"
        data-testid={`automation-scheduler-warn-${kind}`}
      >
        The background scheduler is not installed, so the automation only runs
        while AgentGauge is open.
      </p>
    );
  }

  return null;
}

function StatusSection({
  kind,
  view,
  monitor,
  nowMs,
}: {
  readonly kind: Ipc.ProviderKind;
  readonly view: Ipc.KickoffView;
  readonly monitor: Ipc.AutomationState | null;
  readonly nowMs: number;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md bg-surface/60 p-3">
      <DetailRow
        testId={`automation-next-${kind}`}
        label='Next "Hi"'
        value={formatNextKick(view.nextKickAt, nowMs)}
      />
      <DetailRow
        testId={`automation-observed-reset-${kind}`}
        label="Last reported reset"
        value={formatTime(monitor?.observedResetsAt ?? null, "Not reported")}
      />
      {view.lastAccepted !== null && (
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="text-sm text-muted-foreground">Last attempt</span>
          <span
            className={
              view.lastAccepted
                ? "text-sm text-ok"
                : "text-sm text-critical"
            }
            data-testid={`automation-last-${kind}`}
          >
            {view.lastAccepted ? "Succeeded" : "Failed"}
            {view.lastDetail ? ` — ${view.lastDetail}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}

function DetailRow({
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

function formatNextKick(nextKickAt: number | null, nowMs: number): string {
  if (nextKickAt === null || !Number.isFinite(nextKickAt)) return "—";
  const millis = nextKickAt - nowMs;
  if (millis <= 0) return "due now";
  return `in ${formatCountdown(millis) ?? "—"} · ${formatTimeShort(nextKickAt)}`;
}

function formatTime(ms: number | null, missing: string): string {
  if (ms === null) return missing;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(ms));
}

function formatTimeShort(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function describeError(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  if (typeof cause === "string" && cause.length > 0) return cause;
  return "The operation could not be completed.";
}

export { formatNextKick, buildCommand };
