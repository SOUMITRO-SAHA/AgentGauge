/**
 * The onboarding flow.
 *
 * Each step pairs its copy with a static illustration from
 * `illustrations.tsx`. The flow renders no live data: it looks the same
 * whether Codex is installed, signed out, or unreachable, and a provider is
 * never read just to explain the app.
 *
 * Layout: the flow is fixed to the viewport, so the footer always sits flush
 * with the bottom edge and no step can push the surface into a scroll — the
 * illustration slot shrinks instead.
 */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Effect from "effect/Effect";
import {
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react";
import type { ReactElement } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowClockwise,
  Check,
  Sparkle,
} from "@phosphor-icons/react";

import { onboardingAtom, onboardingVisibleAtom } from "~/atoms";
import {
  AutomationArt,
  RolloverArt,
  StatusArt,
  WelcomeArt,
  WidgetArt,
} from "~/components/onboarding/illustrations";
import { Button } from "~/components/ui/button";
import { Progress } from "~/components/ui/progress";
import * as Ipc from "~/lib/ipc";
import { cn } from "~/lib/utils";

/** The steps, in the same order the Rust `OnboardingStep` enum declares. */
const STEPS: ReadonlyArray<{
  readonly id: Ipc.OnboardingStep;
  readonly title: string;
  readonly blurb: string;
  readonly Art: () => ReactElement;
  readonly demo: string;
}> = [
  {
    id: "welcome",
    title: "A clear view of your coding tools",
    blurb:
      "AgentGauge shows the usage and status information your installed coding tools actually provide. Missing or unsupported data stays clearly marked.",
    Art: WelcomeArt,
    demo: "demo-welcome",
  },
  {
    id: "statusCheck",
    title: "Live status, with its source attached",
    blurb:
      "The dashboard reads your own Codex CLI directly. Every number it shows carries its source, and nothing is shown without saying where it came from.",
    Art: StatusArt,
    demo: "demo-status",
  },
  {
    id: "windowRollover",
    title: "It notices the moment a window resets",
    blurb:
      "Your 5-hour window rolls over on the provider's schedule. This app detects that the instant it happens and tells you, instead of making you check.",
    Art: RolloverArt,
    demo: "demo-rollover",
  },
  {
    id: "widget",
    title: "A real macOS widget",
    blurb:
      "Add it to your desktop or the menu bar from the system widget gallery. It shows your 5-hour window and weekly limit, and macOS refreshes it for you.",
    Art: WidgetArt,
    demo: "demo-widget",
  },
  {
    id: "automation",
    title: "Watching runs in the background",
    blurb:
      "The monitor keeps polling while the app is open. It only ever reads; nothing is sent on your behalf unless you ask for it.",
    Art: AutomationArt,
    demo: "demo-automation",
  },
];

export function OnboardingFlow() {
  const visible = useAtomValue(onboardingVisibleAtom);
  const setVisible = useAtomSet(onboardingVisibleAtom);
  const progress = useAtomValue(onboardingAtom);
  const refreshProgress = useAtomRefresh(onboardingAtom);

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

  /** Advances the persisted step, so a relaunch resumes rather than restarts. */
  const advance = () => {
    const next = STEPS[Math.min(index + 1, STEPS.length - 1)];
    void Effect.runPromise(Ipc.setOnboardingStep(next.id, false)).then(
      refreshProgress,
    );
  };

  const goBack = () => {
    const previous = STEPS[Math.max(index - 1, 0)];
    void Effect.runPromise(Ipc.setOnboardingStep(previous.id, false)).then(
      refreshProgress,
    );
  };

  return (
    <OnboardingBody
      // The flow is the one surface that must render before its read resolves,
      // so an unresolved progress atom falls back to the first step.
      stepIndex={index}
      onNext={advance}
      onBack={goBack}
      onSkip={() => {
        void Effect.runPromise(Ipc.setOnboardingStep("done", true)).then(
          refreshProgress,
        );
        setVisible(false);
      }}
      onFinish={() => setVisible(false)}
      onRefresh={refreshProgress}
    />
  );
}

function OnboardingBody({
  stepIndex,
  onSkip,
  onNext,
  onBack,
  onFinish,
  onRefresh,
}: {
  readonly stepIndex: number;
  readonly onSkip: () => void;
  readonly onNext: () => void;
  readonly onBack: () => void;
  readonly onFinish: () => void;
  readonly onRefresh: () => void;
}) {
  const current = STEPS[Math.min(stepIndex, STEPS.length - 1)];
  const isLast = stepIndex >= STEPS.length - 1;

  return (
    // Fixed to the viewport rather than sized with `svh`/`dvh`: the embedded
    // WKWebView reports unstable viewport-unit heights across window moves,
    // and `inset-0` is exactly the box the surface has to fill.
    <div
      className="fixed inset-0 z-10 flex flex-col overflow-hidden"
      data-testid="onboarding"
    >
      <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col justify-center gap-[clamp(1rem,3vw,2rem)] px-[clamp(1rem,4vw,1.5rem)] py-[clamp(1rem,4vw,2.5rem)]">
        <header className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Sparkle className="size-3.5 shrink-0" aria-hidden="true" />
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

        <section
          className="flex min-h-0 flex-1 items-center justify-center"
          data-testid={current.demo}
        >
          <div className="h-full max-h-72 w-full">
            <current.Art />
          </div>
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
            <ArrowClockwise aria-hidden="true" />
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
            onClick={onBack}
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
