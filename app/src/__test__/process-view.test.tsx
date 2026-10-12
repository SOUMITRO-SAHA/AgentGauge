/**
 * The Processes view must render one panel per group straight from the
 * report — the groups the backend sends are the groups on screen, so a
 * future CLI needs no renderer change — and every state must be an honest
 * one: absent storage shows its reason (never `0 B`), a group with nothing
 * running says so, and the only interactive elements on the whole screen are
 * refreshes, because the capability has no write.
 *
 * Each test resets the module registry before importing: the insights atom
 * is a session-retained singleton, so a second test would inherit the first
 * test's cached answer instead of its own mock.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Request = { readonly type: string };

const HOUR_SEC = 3_600;

function summary(overrides: Record<string, unknown> = {}) {
  return {
    pid: 4242,
    name: "codex",
    command: "codex app-server",
    startedAt: Math.floor(Date.now() / 1000) - HOUR_SEC,
    memoryBytes: 432_000_000,
    listeningPorts: [],
    ...overrides,
  };
}

function group(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    displayName: id === "agentgauge" ? "AgentGauge" : id === "codex" ? "Codex" : "OpenCode",
    processes: [],
    totalMemoryBytes: 0,
    storage: { state: "absent", reason: "has not created its data directory yet." },
    ports: { state: "checked", listening: [] },
    ...overrides,
  };
}

function installDispatch(groups: Array<Record<string, unknown>>): void {
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: ({ request }: { request: Request }) => {
      if (request.type === "processInsights") {
        return { type: "processInsights", insights: { fetchedAt: Date.now(), groups } };
      }
      return {
        type: "failure",
        error: {
          kind: "protocolMismatch",
          message: `unexpected request ${request.type}`,
        },
      };
    },
  };
}

async function renderView(): Promise<void> {
  const { ProcessView } = await import("~/components/views/process-view");
  render(
    createElement(ProcessView as ComponentType<{ visible: boolean }>, {
      visible: true,
    }),
  );
  await screen.findByTestId("process-panel-agentgauge");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__;
  cleanup();
});

it("renders one panel per group, in the order the report carries", async () => {
  installDispatch([group("agentgauge"), group("codex"), group("opencode")]);
  await renderView();

  const panels = await screen.findAllByTestId(/^process-panel-/);
  expect(panels.map((panel) => panel.getAttribute("data-testid"))).toEqual([
    "process-panel-agentgauge",
    "process-panel-codex",
    "process-panel-opencode",
  ]);
});

it("shows each process with its memory and uptime beside the group totals", async () => {
  const pid = 4242;
  installDispatch([
    group("agentgauge", {
      processes: [
        summary({ pid, name: "agentgauge", memoryBytes: 300 }),
        summary({
          pid: 4243,
          name: "com.apple.WebKit.WebContent",
          memoryBytes: 100,
          command: null,
        }),
      ],
      totalMemoryBytes: 400,
      storage: {
        state: "measured",
        totalBytes: 3_000,
        totalFiles: 4,
        rows: [
          { label: "App data", path: "/app-data", bytes: 2_000, fileCount: 3 },
          { label: "Widget & schedule data", path: "/shared", bytes: 1_000, fileCount: 1 },
        ],
      },
    }),
    group("codex"),
    group("opencode"),
  ]);
  await renderView();

  const panel = screen.getByTestId("process-panel-agentgauge");
  expect(panel.contains(screen.getByTestId(`process-row-${pid}`))).toBe(true);
  expect(screen.getByTestId(`process-memory-${pid}`)?.textContent).toBe("300 B");
  expect(screen.getByTestId(`process-uptime-${pid}`)?.textContent).toContain("1h");
  expect(screen.getByTestId("process-totals-agentgauge")?.textContent).toContain("400 B");
  expect(screen.getByTestId("process-totals-agentgauge")?.textContent).toContain("3 kB");
  expect(screen.getByTestId("process-storage-agentgauge")?.textContent).toContain(
    "App data",
  );
  expect(screen.getByTestId("process-storage-agentgauge")?.textContent).toContain("2 kB");
});

it("renders listening ports per process and in the group totals", async () => {
  installDispatch([
    group("agentgauge"),
    group("codex"),
    group("opencode", {
      processes: [
        summary({
          pid: 5309,
          name: "opencode",
          command: "opencode serve --hostname 127.0.0.1",
          listeningPorts: [49374],
        }),
      ],
      ports: {
        state: "checked",
        listening: [{ pid: 5309, port: 49374 }],
      },
    }),
  ]);
  await renderView();

  expect(screen.getByTestId("process-ports-5309")?.textContent).toBe(":49374");
  expect(screen.getByTestId("process-totals-opencode")?.textContent).toContain(
    "49374",
  );
});

it("says none are listening when the scan checked and found nothing", async () => {
  installDispatch([group("agentgauge"), group("codex"), group("opencode")]);
  await renderView();

  expect(screen.getByTestId("process-totals-codex")?.textContent).toContain(
    "None listening",
  );
  expect(screen.queryByTestId("process-ports-unavailable-codex")).toBeNull();
});

it("carries the reason when ports cannot be inspected at all", async () => {
  installDispatch([
    group("agentgauge"),
    group("codex"),
    group("opencode", {
      ports: {
        state: "unavailable",
        reason: "Listening ports could not be inspected: program not found.",
      },
    }),
  ]);
  await renderView();

  expect(
    screen.getByTestId("process-ports-unavailable-opencode")?.textContent,
  ).toContain("could not be inspected");
  expect(screen.getByTestId("process-totals-opencode")?.textContent).not.toContain(
    "None listening",
  );
});

it("names the databases inside the storage breakdown", async () => {
  installDispatch([
    group("agentgauge"),
    group("codex", {
      storage: {
        state: "measured",
        totalBytes: 500_000_000,
        totalFiles: 95,
        rows: [
          {
            label: "Databases (SQLite)",
            path: "state_5.sqlite, thread_history_1.sqlite, goals_1.sqlite",
            bytes: 60_000_000,
            fileCount: 5,
          },
          { label: "Everything else", path: "/Users/dev/.codex", bytes: 440_000_000, fileCount: 90 },
        ],
      },
    }),
    group("opencode"),
  ]);
  await renderView();

  const storage = screen.getByTestId("process-storage-codex");
  expect(storage.textContent).toContain("Databases (SQLite)");
  expect(storage.textContent).toContain("state_5.sqlite");
  expect(storage.textContent).toContain("60 MB");
});

it("renders an absent footprint as its reason, never as zero bytes", async () => {
  installDispatch([
    group("agentgauge"),
    group("codex"),
    group("opencode", {
      storage: {
        state: "absent",
        reason: "OpenCode has not created `/Users/dev/.local/share/opencode` yet.",
      },
    }),
  ]);
  await renderView();

  const absent = screen.getByTestId("process-storage-absent-opencode");
  expect(absent.textContent).toContain("has not created");
  // A measured zero would read as emptiness; absence must stay a reason.
  expect(absent.textContent).not.toContain("0 B");
  expect(screen.queryByTestId("process-storage-opencode")).toBeNull();
});

it("says explicitly when a group has nothing running", async () => {
  installDispatch([
    group("agentgauge"),
    group("codex"),
    group("opencode", { processes: [], storage: { state: "measured", totalBytes: 5, totalFiles: 1, rows: [] } }),
  ]);
  await renderView();

  expect(screen.getByTestId("process-empty-opencode")?.textContent).toContain(
    "No OpenCode processes",
  );
});

it("marks a re-read in flight instead of rendering it as fresh", async () => {
  installDispatch([group("agentgauge"), group("codex"), group("opencode")]);
  await renderView();

  // Swap the mock for one that never answers, then refresh: the retained
  // snapshot must stay on screen *and* say a re-read is running.
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: () =>
      new Promise(() => {
        // Deliberately unresolved: the read stays in flight.
      }),
  };
  fireEvent.click(screen.getByTestId("refresh-processes-agentgauge"));

  expect(await screen.findByTestId("process-refreshing")).toBeTruthy();
  expect(screen.getByTestId("process-panel-agentgauge")).toBeTruthy();
});

it("offers no control beyond refresh, because the capability has no write", async () => {
  installDispatch([group("agentgauge"), group("codex"), group("opencode")]);
  await renderView();

  const buttons = screen.getAllByRole("button");
  const testids = buttons.map((button) => button.getAttribute("data-testid") ?? "");
  expect(testids.length).toBeGreaterThan(0);
  for (const testid of testids) {
    expect(testid.startsWith("refresh-processes-")).toBe(true);
  }
});
