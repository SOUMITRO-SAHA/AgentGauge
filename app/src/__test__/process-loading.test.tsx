import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let processReadResolvers: Array<(value: unknown) => void> = [];

function processGroup(id: string) {
  return {
    id,
    displayName: id === "codex" ? "Codex" : "OpenCode",
    processes: [],
    totalMemoryBytes: 0,
    totalCpuUsage: null,
    storage: { state: "absent", reason: "No data yet." },
    ports: { state: "checked", listening: [] },
    service: null,
  };
}

function releaseProcessReads(): void {
  for (const resolve of processReadResolvers.splice(0)) {
    resolve({
      type: "processInsights",
      insights: {
        fetchedAt: Date.now(),
        groups: [processGroup("codex"), processGroup("opencode")],
      },
    });
  }
}

beforeEach(() => {
  vi.resetModules();
  processReadResolvers = [];
});

afterEach(() => {
  releaseProcessReads();
  delete (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__;
  cleanup();
});

it("reserves the process panel shape while the first snapshot loads", async () => {
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: () =>
      new Promise((resolve: (value: unknown) => void) => {
        processReadResolvers.push(resolve);
      }),
  };
  const { ProcessView } = await import("~/components/views/process-view");
  render(
    createElement(ProcessView as ComponentType<{ visible: boolean }>, {
      visible: true,
    }),
  );

  const skeleton = await screen.findByTestId("process-loading-skeleton");
  expect(skeleton.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(8);

  releaseProcessReads();
  expect(await screen.findByTestId("process-panel-codex")).toBeTruthy();
  expect(screen.queryByTestId("process-loading-skeleton")).toBeNull();
});
