/**
 * The onboarding flow.
 *
 * Each step pairs its copy with a static illustration from
 * `illustrations.tsx`. The flow renders no live data: it looks the same
 * whether Codex is installed, signed out, or unreachable, and a provider is
 * never read just to explain the app.
 *
 * Layout: the flow is fixed to the viewport, so the footer always sits flush
 * with the bottom edge and no step can push the surface into a scroll. The
 * step's header, copy, and illustration center as one group on a single gap
 * rhythm; the illustration slot grows with the available viewport height but
 * can contract at the minimum window size rather than stranding the art in a
 * stretched hole between the copy and the footer.
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
    title: "Your coding limits, in view",
    blurb:
      "AgentGauge brings the usage windows your installed coding harness actually reports into one local view. Codex is supported today; OpenCode and Pi are on the roadmap.",
    Art: WelcomeArt,
    demo: "demo-welcome",
  },
  {
    id: "statusCheck",
    title: "Know what you can trust",
    blurb:
      "See Codex's reported five-hour and weekly usage, reset times, source, and last check. Missing or stale data is called out—not turned into zero.",
    Art: StatusArt,
    demo: "demo-status",
  },
  {
    id: "windowRollover",
    title: "Catch the next reported window",
    blurb:
      "When Codex reports a new reset time, AgentGauge can notice the change between checks. Codex controls the schedule; a prompt cannot start or extend a window.",
    Art: RolloverArt,
    demo: "demo-rollover",
  },
  {
    id: "widget",
    title: "Keep usage in sight",
    blurb:
      "Add the AgentGauge widget from the macOS widget gallery to glance at Codex's five-hour and weekly snapshots. You place it; macOS controls refresh timing.",
    Art: WidgetArt,
    demo: "demo-widget",
  },
  {
    id: "automation",
    title: "Watch without spending quota",
    blurb:
      "The monitor checks Codex without sending prompts or using quota. An optional kickoff can send one trivial 'Hi' with a model you choose about a minute after each 5-hour reset; it uses a little quota and runs only if you opt in.",
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

  // `visible` is the session-local override: once the user skips or finishes,
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

  const dismiss = () => {
    void Effect.runPromise(Ipc.setOnboardingStep("done", true)).then(
      refreshProgress,
    );
    setVisible(false);
  };

  return (
    <OnboardingBody
      // The flow is the one surface that must render before its read resolves,
      // so an unresolved progress atom falls back to the first step.
      stepIndex={index}
      onNext={advance}
      onBack={goBack}
      onSkip={dismiss}
      onFinish={dismiss}
    />
  );
}

function OnboardingBody({
  stepIndex,
  onSkip,
  onNext,
  onBack,
  onFinish,
}: {
  readonly stepIndex: number;
  readonly onSkip: () => void;
  readonly onNext: () => void;
  readonly onBack: () => void;
  readonly onFinish: () => void;
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
      <div
        className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col justify-center gap-[clamp(1rem,3vw,2rem)] px-[clamp(1rem,4vw,1.5rem)] py-[clamp(1rem,4vw,2.5rem)]"
        data-testid="onboarding-content"
      >
        <header className="flex flex-col gap-5">
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
          <h1 className="font-display text-[clamp(1.375rem,5vw,1.875rem)] font-semibold tracking-tight text-foreground">
            {current.title}
          </h1>
          <p className="text-[clamp(0.875rem,2.5vw,1rem)] leading-relaxed text-muted-foreground">
            {current.blurb}
          </p>
        </section>

        <section
          className="flex items-center justify-center"
          data-testid={current.demo}
        >
          <div className="mx-auto aspect-[8/5] w-[min(100%,60vw,58vh)]">
            <current.Art />
          </div>
        </section>
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border/70 bg-accent-glass px-[clamp(1rem,4vw,1.5rem)] py-2 backdrop-blur-md sm:py-3">
        <div className="flex min-w-0 items-center gap-1">
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
