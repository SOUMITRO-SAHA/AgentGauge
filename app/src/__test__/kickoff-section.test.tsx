/**
 * The scheduled-kickoff controls must be honest in every state.
 *
 * Opt-in is the core contract: the toggle renders off and the schedule block
 * is absent until it is switched on. The countdown must never render a past
 * schedule as a negative time — "due now" is what a worker that has not fired
 * yet looks like — and an unsupported platform must say so instead of
 * pretending the background schedule exists.
 *
 * Each test resets the module registry before importing: the kickoff atom is
 * a session-retained singleton, so a second test reading it would inherit the
 * first test's cached answer instead of its own mock.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Request = { readonly type: string; readonly kind?: string };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__;
  cleanup();
});

function kickoffState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const enabled = overrides.enabled === true;
  return {
    type: "kickoff",
    state: {
      subscriptions: [
        {
          kind: "zai",
          enabled,
          modelId: null,
          effectiveModel: "glm-5.3-flash",
          models: [
            { id: "glm-5.3", label: "GLM-5.3", cheapest: false },
            { id: "glm-5.3-flash", label: "GLM-5.3 Flash", cheapest: true },
          ],
          nextKickAt: enabled
            ? ((overrides.nextKickAtMs as number | undefined) ?? Date.now() + 2 * 3_600_000)
            : null,
          lastKickAt: null,
          lastAccepted:
            (overrides.lastAccepted as boolean | null | undefined) ?? null,
          lastDetail: null,
        },
      ],
      scheduler: (overrides.scheduler as Record<string, unknown> | undefined) ?? {
        supported: true,
        installed: false,
      },
    },
  };
}

function installDispatch(response: Record<string, unknown>): void {
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: ({ request }: { request: Request }) => {
      switch (request.type) {
        case "kickoffState":
        case "setKickoffEnabled":
          return response;
        default:
          return {
            type: "failure",
            error: {
              kind: "protocolMismatch",
              message: `unexpected request ${request.type}`,
            },
          };
      }
    },
  };
}

async function renderSection(
  response: Record<string, unknown>,
): Promise<void> {
  installDispatch(response);
  const { KickoffSection } = await import("~/components/automation/kickoff-section");
  render(createElement(KickoffSection as ComponentType<{ kind: string; nowMs: number }>, {
    kind: "zai",
    nowMs: Date.now(),
  }));
}

it("renders opted out with a model picker but no scheduled attempt", async () => {
  await renderSection(kickoffState({ enabled: false }));

  const toggle = await screen.findByTestId("kickoff-toggle-zai");
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(screen.getByTestId("kickoff-model-zai").textContent).toContain(
    "GLM-5.3 Flash",
  );
  expect(screen.queryByTestId("kickoff-next-zai")).toBeNull();
});

it("renders the schedule, selected model, and countdown once enabled", async () => {
  await renderSection(kickoffState({ enabled: true }));

  const toggle = await screen.findByTestId("kickoff-toggle-zai");
  expect(toggle.getAttribute("aria-checked")).toBe("true");

  const next = await screen.findByTestId("kickoff-next-zai");
  expect(next.textContent).toContain("1h");

  expect(screen.getByTestId("kickoff-model-zai").textContent).toContain(
    "GLM-5.3 Flash",
  );
  expect(screen.getByTestId("kickoff-section-zai").textContent).not.toContain(
    "cheapest",
  );
});

it("explains reported-reset timing, quota use, and unknown model availability", async () => {
  await renderSection(kickoffState({ enabled: false }));

  const section = await screen.findByTestId("kickoff-section-zai");
  expect(section.textContent).toContain("latest reported reset time");
  expect(section.textContent).toContain("does not verify a rollover");
  expect(section.textContent).toContain("uses quota");
  expect(section.textContent).toContain("does not create, reset, or extend");
  expect(section.textContent).toContain("availability and quota impact are unknown");
});

it("says due now rather than counting a passed schedule negatively", async () => {
  await renderSection(
    kickoffState({ enabled: true, nextKickAtMs: Date.now() - 5_000 }),
  );

  expect((await screen.findByTestId("kickoff-next-zai")).textContent).toBe(
    "due now",
  );
});

it("says an unsupported platform cannot schedule in the background", async () => {
  await renderSection(
    kickoffState({
      enabled: true,
      scheduler: { supported: false, installed: false },
    }),
  );

  expect(await screen.findByTestId("kickoff-unsupported-zai")).toBeTruthy();
});

it("shows the last attempt's outcome once there was one", async () => {
  await renderSection(kickoffState({ enabled: true, lastAccepted: false }));

  const last = await screen.findByTestId("kickoff-last-zai");
  expect(last.textContent).toContain("failed");
});
