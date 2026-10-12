import { RegistryProvider } from "@effect/atom-react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Progress = {
  readonly step: string;
  readonly dismissed: boolean;
  readonly index: number;
  readonly total: number;
  readonly visible: boolean;
};

let progressResolver: ((value: unknown) => void) | undefined;
let OnboardingFlow: ComponentType;

function installDeferredProgress(): void {
  progressResolver = undefined;
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: ({ request }: { request: { type: string } }) => {
      if (request.type === "onboardingProgress") {
        return new Promise((resolve: (value: unknown) => void) => {
          progressResolver = resolve;
        });
      }
      return {
        type: "failure",
        error: { kind: "protocolMismatch", message: `unexpected ${request.type}` },
      };
    },
  };
}

function releaseResponse(response: unknown): void {
  progressResolver?.(response);
}

function progressReply(progress: Progress): unknown {
  return { type: "onboarding", progress };
}

beforeEach(async () => {
  vi.resetModules();
  installDeferredProgress();
  OnboardingFlow = (await import("~/components/onboarding/onboarding-flow")).OnboardingFlow;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__;
});

it("does not show onboarding before persisted progress confirms a first run", async () => {
  render(
    createElement(
      RegistryProvider,
      {},
      createElement(OnboardingFlow),
    ),
  );

  expect(screen.queryByTestId("onboarding")).toBeNull();

  releaseResponse(progressReply({
    step: "done",
    dismissed: true,
    index: 5,
    total: 6,
    visible: false,
  }));

  await waitFor(() => expect(screen.queryByTestId("onboarding")).toBeNull());
});

it("shows onboarding after persisted progress confirms a first run", async () => {
  render(
    createElement(
      RegistryProvider,
      {},
      createElement(OnboardingFlow),
    ),
  );

  expect(screen.queryByTestId("onboarding")).toBeNull();

  releaseResponse(progressReply({
    step: "welcome",
    dismissed: false,
    index: 0,
    total: 6,
    visible: true,
  }));

  expect(await screen.findByTestId("onboarding")).toBeTruthy();
});

it("does not assume a first run when the persisted read fails", async () => {
  render(
    createElement(
      RegistryProvider,
      {},
      createElement(OnboardingFlow),
    ),
  );

  releaseResponse({
    type: "failure",
    error: { kind: "storage", message: "state unavailable" },
  });

  await waitFor(() => expect(screen.queryByTestId("onboarding")).toBeNull());
});
