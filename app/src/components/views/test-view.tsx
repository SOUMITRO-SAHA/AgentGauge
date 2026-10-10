import * as Effect from "effect/Effect";
import { useAtomRefresh, useAtomSet } from "@effect/atom-react";
import { Flask } from "@phosphor-icons/react";

import { onboardingAtom, onboardingVisibleAtom } from "~/atoms";
import { Panel } from "~/components/dashboard/panel";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ViewHeader } from "~/components/views/view-header";
import * as Ipc from "~/lib/ipc";
import { ROUTES, type Route } from "~/lib/navigation";

const ONBOARDING_STEPS: ReadonlyArray<{
  readonly id: Exclude<Ipc.OnboardingStep, "done">;
  readonly label: string;
}> = [
  { id: "welcome", label: "Welcome" },
  { id: "statusCheck", label: "Status source" },
  { id: "windowRollover", label: "Rollover" },
  { id: "widget", label: "Widget" },
  { id: "automation", label: "Monitor" },
];

export function TestView({
  visible,
  onNavigate,
}: {
  readonly visible: boolean;
  readonly onNavigate: (route: Route) => void;
}) {
  const setOnboardingVisible = useAtomSet(onboardingVisibleAtom);
  const refreshOnboarding = useAtomRefresh(onboardingAtom);

  const openOnboardingStep = (step: Ipc.OnboardingStep) => {
    void Effect.runPromise(Ipc.setOnboardingStep(step, false))
      .then(async () => {
        await refreshOnboarding();
        setOnboardingVisible(true);
      })
      .catch((error) => {
        console.error("AgentGauge: could not open the onboarding step", error);
      });
  };

  return (
    <div
      className={visible ? "flex flex-col gap-4" : "hidden"}
      data-testid="view-test"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <ViewHeader
          title="Test"
          subtitle="Developer-only navigation and onboarding checks."
        />
        <Badge variant="outline" className="mt-1 gap-1.5">
          <Flask aria-hidden="true" />
          Dev only
        </Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel testId="test-screen-navigation">
          <div className="mb-4 flex flex-col gap-1">
            <h2 className="text-sm font-semibold text-foreground">
              App screens
            </h2>
            <p className="text-sm text-muted-foreground">
              Open a destination using the same route action as the main
              navigation.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {ROUTES.map((definition) => {
              const Icon = definition.icon;
              return (
                <Button
                  key={definition.id}
                  variant="outline"
                  className="justify-start"
                  data-testid={`test-screen-${definition.id}`}
                  onClick={() => onNavigate(definition.id)}
                >
                  <Icon aria-hidden="true" />
                  {definition.label}
                </Button>
              );
            })}
          </div>
        </Panel>

        <div className="md:col-span-2">
          <Panel testId="test-onboarding-navigation">
            <div className="mb-4 flex flex-col gap-1">
              <h2 className="text-sm font-semibold text-foreground">
                Onboarding steps
              </h2>
              <p className="text-sm text-muted-foreground">
                Open any step directly, or start the complete five-step flow.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {ONBOARDING_STEPS.map((step, index) => (
                <Button
                  key={step.id}
                  variant="outline"
                  className="h-auto min-h-9 min-w-0 justify-start whitespace-normal px-2 py-2 text-left"
                  data-testid={`test-onboarding-step-${step.id}`}
                  onClick={() => openOnboardingStep(step.id)}
                >
                  <span className="tabular text-muted-foreground">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0">{step.label}</span>
                </Button>
              ))}
              <Button
                data-testid="test-onboarding-replay"
                onClick={() => openOnboardingStep("welcome")}
                className="col-span-2"
              >
                Replay onboarding
              </Button>
            </div>
          </Panel>
        </div>
      </div>

      <p
        className="border-t border-border/60 pt-4 text-xs text-muted-foreground"
        data-testid="test-safety-note"
      >
        These checks only change the selected screen or onboarding progress.
        They never send a prompt or consume usage.
      </p>
    </div>
  );
}
