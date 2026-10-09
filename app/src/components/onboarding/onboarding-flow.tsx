/**
 * The onboarding flow.
 *
 * No auth: it demonstrates what the app does against the user's own installed
 * Codex, so every step renders live data rather than a screenshot of it. That is
 * the point of the flow — it shows the real state, including "not installed".
 */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Effect from "effect/Effect";
import {
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  LayoutPanelTop,
  RefreshCw,
  Sparkles,
} from "lucide-react";

import {
  automationAtom,
  onboardingAtom,
  onboardingVisibleAtom,
  usageAtom,
  widgetAtom,
} from "~/atoms";
import { Button } from "~/components/ui/button";
import { Progress } from "~/components/ui/progress";
import { ProviderStatusCard } from "~/components/usage/provider-status-card";
import { UsageWindowList } from "~/components/usage/usage-window-row";
import * as Ipc from "~/lib/ipc";
import { cn } from "~/lib/utils";
import { formatCountdown, millisUntilReset } from "~/lib/usage";

/** The steps, in the same order the Rust `OnboardingStep` enum declares. */
const STEPS: ReadonlyArray<{
  readonly id: Ipc.OnboardingStep;
  readonly title: string;
  readonly blurb: string;
}> = [
  {
    id: "welcome",
    title: "Never wait for a window again",
    blurb:
      "AI Sub Stats watches your Codex 5-hour window so a fresh one is always ready when you sit down to work.",
  },
  {
    id: "statusCheck",
    title: "Live status, with its source attached",
    blurb:
      "Every number below is read from your own Codex CLI. Nothing is estimated, and nothing is shown without saying where it came from.",
  },
  {
    id: "windowRollover",
    title: "It notices the moment a window resets",
    blurb:
      "Your 5-hour window rolls over on the provider's schedule. This app detects that the instant it happens and tells you, instead of making you check.",
  },
  {
    id: "widget",
    title: "A widget that lives on your desktop",
    blurb:
      "Pin the reading to a small always-on-top window so you can see your remaining window without opening the app.",
  },
  {
    id: "automation",
    title: "Watching runs in the background",
    blurb:
      "The watcher keeps polling while the app is open. It only ever reads; nothing is sent on your behalf unless you ask for it.",
  },
];

export function OnboardingFlow() {
  const visible = useAtomValue(onboardingVisibleAtom);
  const setVisible = useAtomSet(onboardingVisibleAtom);
  const progress = useAtomValue(onboardingAtom);
  const usage = useAtomValue(usageAtom);
  const widget = useAtomValue(widgetAtom);
  const automation = useAtomValue(automationAtom);
  const refreshProgress = useAtomRefresh(onboardingAtom);
  const refreshUsage = useAtomRefresh(usageAtom);
  const refreshWidget = useAtomRefresh(widgetAtom);
  const refreshAutomation = useAtomRefresh(automationAtom);

  // Rust owns the "should this reappear" rule. Until the read resolves the flow
  // is shown — a returning user sees it for one frame, which is harmless — and
  // the moment the answer arrives the gate is authoritative.
  //
  // Derived rather than written to the atom: writing here would be a state
  // update in the render phase, and React would warn about it.
  const persistedVisible = AsyncResult.match(progress, {
    onInitial: () => true,
    onSuccess: (result) => result.value.visible,
    onFailure: () => true,
  });

  // `skipped` is the session-local override: once the user skips or finishes,
  // the flow stays hidden even though Rust still reports it as visible.
  const show = visible && persistedVisible;

  if (!show) return null;

  const index = AsyncResult.match(progress, {
    onInitial: () => 0,
    onSuccess: (result) => result.value.index,
    onFailure: () => 0,
  });
  const isLast = index >= STEPS.length - 1;

  /** Advances the persisted step, so a relaunch resumes rather than restarts. */
  const advance = () => {
    const next = STEPS[Math.min(index + 1, STEPS.length - 1)];
    void Effect.runPromise(Ipc.setOnboardingStep(next.id, isLast)).then(
      refreshProgress,
    );
  };

  return (
    <OnboardingBody
      // The flow is the one surface that must render before its read resolves,
      // so an unresolved progress atom falls back to the first step.
      stepIndex={index}
      onNext={advance}
      onSkip={() => {
        void Effect.runPromise(Ipc.setOnboardingStep("done", true)).then(
          refreshProgress,
        );
        setVisible(false);
      }}
      onFinish={() => setVisible(false)}
      usage={usage}
      widget={widget}
      automation={automation}
      onRefresh={() => {
        // Re-reads everything the flow shows, including its own step. Leaving
        // the step out would mean "Re-read" refreshed the panels but not the
        // gate, so the flow could disagree with the progress it displays.
        refreshProgress();
        refreshUsage();
        refreshWidget();
        refreshAutomation();
      }}
      onSetupWidget={() => {
        void Effect.runPromise(Ipc.setupWidget()).then(refreshWidget);
      }}
      onStartAutomation={() => {
        void Effect.runPromise(Ipc.startAutomation()).then(refreshAutomation);
      }}
    />
  );
}

function OnboardingBody({
  stepIndex,
  onSkip,
  onNext,
  onFinish,
  usage,
  widget,
  automation,
  onRefresh,
  onSetupWidget,
  onStartAutomation,
}: {
  readonly stepIndex: number;
  readonly onSkip: () => void;
  readonly onNext: () => void;
  readonly onRefresh: () => void;
  readonly onFinish: () => void;
  readonly usage: AsyncResult.AsyncResult<ReadonlyArray<Ipc.UsageSnapshot>, unknown>;
  readonly widget: AsyncResult.AsyncResult<Ipc.WidgetStatus, unknown>;
  readonly automation: AsyncResult.AsyncResult<Ipc.AutomationState, unknown>;
  readonly onSetupWidget: () => void;
  readonly onStartAutomation: () => void;
}) {
  const current = STEPS[Math.min(stepIndex, STEPS.length - 1)];
  const isLast = stepIndex >= STEPS.length - 1;

  return (
    // Responsive: a single fluid column that scales with the viewport, so the
    // same flow works in a small window and a maximised one. `overflow-y-auto`
    // keeps the footer reachable when the content is taller than the window.
    <div
      className="flex h-full flex-col overflow-hidden"
      data-testid="onboarding"
    >
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-[clamp(1rem,3vw,2rem)] px-[clamp(1rem,4vw,1.5rem)] py-[clamp(1rem,4vw,2.5rem)]">
        <header className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Sparkles className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="tabular">
              Step {Math.min(stepIndex + 1, STEPS.length)} of {STEPS.length}
            </span>
          </div>
          <Progress
            value={Math.min(stepIndex + 1, STEPS.length)}
            max={STEPS.length}
            aria-label="Onboarding progress"
            data-testid="onboarding-progress"
          />
        </header>

        <section className="flex flex-col gap-3">
          <h1 className="text-[clamp(1.375rem,5vw,1.875rem)] font-semibold tracking-tight text-foreground">
            {current.title}
          </h1>
          <p className="text-[clamp(0.875rem,2.5vw,1rem)] leading-relaxed text-muted-foreground">
            {current.blurb}
          </p>
        </section>

        <section className="min-h-[min(15rem,40vh)]">
          {current.id === "statusCheck" && <StatusCheckDemo usage={usage} />}
          {current.id === "windowRollover" && <RolloverDemo automation={automation} />}
          {current.id === "widget" && (
            <WidgetDemo widget={widget} onSetup={onSetupWidget} />
          )}
          {current.id === "automation" && (
            <AutomationDemo
              automation={automation}
              onStart={onStartAutomation}
            />
          )}
        </section>
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border/70 bg-accent-glass px-[clamp(1rem,4vw,1.5rem)] py-3 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={onRefresh}
            data-testid="onboarding-refresh"
          >
            <RefreshCw aria-hidden="true" />
            <span className="hidden sm:inline">Re-read</span>
          </Button>
          <Button
            variant="ghost"
            onClick={onSkip}
            data-testid="onboarding-skip"
          >
            Skip
          </Button>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            onClick={onSkip}
            data-testid="onboarding-back"
            aria-label="Back"
            disabled={stepIndex === 0}
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
          <Button
            onClick={isLast ? onFinish : onNext}
            data-testid="onboarding-next"
            className={cn(isLast && "gap-2")}
          >
            {isLast ? (
              <>
                <Check aria-hidden="true" />
                Finish
              </>
            ) : (
              <>
                Next
                <ArrowRight aria-hidden="true" />
              </>
            )}
          </Button>
        </div>
      </footer>
    </div>
  );
}

function StatusCheckDemo({
  usage,
}: {
  readonly usage: AsyncResult.AsyncResult<ReadonlyArray<Ipc.UsageSnapshot>, unknown>;
}) {
  return (
    <div className="flex flex-col gap-[clamp(0.75rem,2.5vw,1rem)]" data-testid="demo-status">
      <ProviderStatusCard />
      <div className="rounded-xl border border-border/70 bg-surface-raised/70 p-[clamp(0.75rem,2.5vw,1.25rem)] backdrop-blur-md">
        {AsyncResult.match(usage, {
          onInitial: () => <p className="text-sm text-muted-foreground">Reading…</p>,
          onSuccess: (result) => {
            const codex = result.value.find(
              (snapshot) => snapshot.provider === "codex",
            );
            return codex ? (
              <UsageWindowList result={AsyncResult.success(codex)} nowMs={Date.now()} />
            ) : (
              <p className="text-sm text-muted-foreground">
                No provider reported any usage.
              </p>
            );
          },
          onFailure: () => (
            <p className="text-sm text-muted-foreground">
              The app could not be reached.
            </p>
          ),
        })}
      </div>
    </div>
  );
}

/** A reset countdown, or an explicit unknown rather than a blank. */
function resetLabel(millis: number | null): string {
  const countdown = formatCountdown(millis);
  return countdown === null
    ? "Your current 5-hour window resets at an unknown time."
    : `Your current 5-hour window resets in ${countdown}.`;
}

function RolloverDemo({
  automation,
}: {
  readonly automation: AsyncResult.AsyncResult<Ipc.AutomationState, unknown>;
}) {
  return (
    <div
      className="flex flex-col gap-4 rounded-xl border border-border/70 bg-surface-raised/70 p-5 backdrop-blur-md"
      data-testid="demo-rollover"
    >
      {AsyncResult.match(automation, {
        onInitial: () => (
          <p className="text-sm text-muted-foreground">Checking the watcher…</p>
        ),
        onSuccess: (result) => {
          const state = result.value;
          const reset = millisUntilReset(state.observedResetsAt, Date.now());
          return (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">
                  Watcher is {state.running ? "running" : "not running"}
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                {state.observedResetsAt === null
                  ? "No reset time observed yet."
                  : resetLabel(reset)}
              </p>
              <p className="text-sm text-muted-foreground">
                {state.rolledOver
                  ? "A new window was detected since you last looked."
                  : "No new window has rolled over yet."}
              </p>
            </div>
          );
        },
        onFailure: () => (
          <p className="text-sm text-muted-foreground">
            The app could not be reached.
          </p>
        ),
      })}
    </div>
  );
}

function WidgetDemo({
  widget,
  onSetup,
}: {
  readonly widget: AsyncResult.AsyncResult<Ipc.WidgetStatus, unknown>;
  readonly onSetup: () => void;
}) {
  return (
    <div
      className="flex flex-col gap-4 rounded-xl border border-border/70 bg-surface-raised/70 p-5 backdrop-blur-md"
      data-testid="demo-widget"
    >
      {AsyncResult.match(widget, {
        onInitial: () => (
          <p className="text-sm text-muted-foreground">Checking the widget…</p>
        ),
        onSuccess: (result) =>
          result.value.installed ? (
            <div className="flex items-center gap-2" data-testid="widget-ready">
              <LayoutPanelTop className="size-4 text-ok" aria-hidden="true" />
              <span className="text-sm text-foreground">
                Your widget is set up and always on top.
              </span>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3">
              <span className="text-sm text-foreground">
                {result.value.reason ?? "The widget window is not open."}
              </span>
              <Button onClick={onSetup} data-testid="widget-setup">
                Set up the widget
              </Button>
            </div>
          ),
        onFailure: () => (
          <p className="text-sm text-muted-foreground">
            The app could not be reached.
          </p>
        ),
      })}
    </div>
  );
}

function AutomationDemo({
  automation,
  onStart,
}: {
  readonly automation: AsyncResult.AsyncResult<Ipc.AutomationState, unknown>;
  readonly onStart: () => void;
}) {
  return (
    <div
      className="flex flex-col gap-4 rounded-xl border border-border/70 bg-surface-raised/70 p-5 backdrop-blur-md"
      data-testid="demo-automation"
    >
      {AsyncResult.match(automation, {
        onInitial: () => (
          <p className="text-sm text-muted-foreground">Checking the watcher…</p>
        ),
        onSuccess: (result) => (
          <div className="flex flex-col items-start gap-3">
            <span className="text-sm text-foreground">
              {result.value.running
                ? "The watcher is already running in the background."
                : "The watcher is stopped."}
            </span>
            {!result.value.running && (
              <Button onClick={onStart} data-testid="automation-start">
                Start watching
              </Button>
            )}
          </div>
        ),
        onFailure: () => (
          <p className="text-sm text-muted-foreground">
            The app could not be reached.
          </p>
        ),
      })}
    </div>
  );
}