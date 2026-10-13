/**
 * The Processes view must render one panel per group straight from the
 * report — the groups the backend sends are the groups on screen, so a
 * future CLI needs no renderer change — and every state must be an honest
 * one: absent storage shows its reason (never `0 B`), a group with nothing
 * running says so, and the only interactive elements on the whole screen
 * are refreshes, because the capability has no write. The one exception is
 * the error state's re-read, which is the same refresh offered where the
 * panels cannot.
 *
 * Each test resets the module registry before importing: the insights atom
 * is a session-retained singleton, so a second test would inherit the first
 * test's cached answer instead of its own mock.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Request = { readonly type: string };

let processReadResolvers: Array<(value: unknown) => void> = [];

function releaseProcessRead(): void {
  for (const resolve of processReadResolvers.splice(0)) {
    resolve({
      type: "processInsights",
      insights: {
        fetchedAt: Date.now(),
        groups: [group("codex"), group("opencode")],
      },
    });
  }
}

const HOUR_SEC = 3_600;

function summary(overrides: Record<string, unknown> = {}) {
  return {
    pid: 4242,
    name: "codex",
    command: "codex app-server",
    startedAt: Math.floor(Date.now() / 1000) - HOUR_SEC,
    memoryBytes: 432_000_000,
    cpuUsage: null,
    status: null,
    listeningPorts: [],
    ...overrides,
  };
}

function group(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    displayName: id === "codex" ? "Codex" : "OpenCode",
    processes: [],
    totalMemoryBytes: 0,
    totalCpuUsage: null,
    storage: {
      state: "absent",
      reason: "has not created its data directory yet.",
    },
    ports: { state: "checked", listening: [] },
    service: null,
    ...overrides,
  };
}

function measuredStorage(overrides: Record<string, unknown> = {}) {
  return {
    state: "measured",
    totalBytes: 3_000,
    totalFiles: 4,
    rows: [],
    externalRows: [],
    ...overrides,
  };
}

function installDispatch(groups: Array<Record<string, unknown>>): void {
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: ({ request }: { request: Request }) => {
      if (request.type === "processInsights") {
        return {
          type: "processInsights",
          insights: { fetchedAt: Date.now(), groups },
        };
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
  await screen.findByTestId("process-panel-codex");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  releaseProcessRead();
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
  expect(
    skeleton.querySelectorAll('[data-slot="skeleton"]').length,
  ).toBeGreaterThan(8);

  releaseProcessRead();
  expect(await screen.findByTestId("process-panel-codex")).toBeTruthy();
  expect(screen.queryByTestId("process-loading-skeleton")).toBeNull();
});

it("mirrors the success shape while loading: one skeleton panel per group plus the note", async () => {
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

  const panels = await screen.findAllByTestId("process-loading-panel");
  expect(panels).toHaveLength(1);
  const tabs = await screen.findByTestId("process-loading-tabs");
  expect(
    tabs.querySelectorAll('[data-testid="process-loading-tab"]'),
  ).toHaveLength(2);
  expect(await screen.findByTestId("process-loading-note")).toBeTruthy();
  expect(screen.getByTestId("process-refreshing")).toBeTruthy();

  releaseProcessRead();
});

it("keeps the refresh-status slot mounted when a re-read completes", async () => {
  installDispatch([group("codex"), group("opencode")]);
  await renderView();

  let holder: ((value: Record<string, unknown>) => void) | null = null;
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: ({ request }: { request: Request }) => {
      if (request.type !== "processInsights") {
        return {
          type: "failure",
          error: { kind: "protocolMismatch", message: "x" },
        };
      }
      return new Promise((resolve) => {
        holder = resolve as (value: Record<string, unknown>) => void;
      });
    },
  };
  fireEvent.click(screen.getByTestId("refresh-processes-codex"));

  const status = await screen.findByTestId("process-refreshing");
  expect(status.textContent).toContain("Refreshing");
  expect(status.className).not.toContain("invisible");

  // Narrowed through a local so TS does not fold the callback assignment away.
  const settle = (value: Record<string, unknown>) => {
    (holder as ((v: Record<string, unknown>) => void) | null)?.(value);
  };
  settle({
    type: "processInsights",
    insights: {
      fetchedAt: Date.now(),
      groups: [group("codex"), group("opencode")],
    },
  });
  await screen.findByTestId("process-panel-codex");
  const settled = screen.getByTestId("process-refreshing");
  expect(settled.className).toContain("invisible");
});

/**
 * Activates a group's tab, the way a user reaches that group's panel. Radix
 * triggers answer `mousedown`, not a bare `click` — the same pair the Stats
 * tab tests use.
 */
async function switchTo(groupId: string): Promise<void> {
  const tab = screen.getByTestId(`process-tab-${groupId}`);
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
  await screen.findByTestId(`process-panel-${groupId}`);
}

it("renders one tab per group and shows the active group's panel", async () => {
  installDispatch([group("codex"), group("opencode")]);
  await renderView();

  const tabs = screen
    .getAllByTestId(/^process-tab-/)
    .map((tab) => tab.getAttribute("data-testid"));
  expect(tabs).toEqual(["process-tab-codex", "process-tab-opencode"]);

  expect(screen.getByTestId("process-panel-codex")).toBeTruthy();
  expect(screen.queryByTestId("process-panel-opencode")).toBeNull();

  await switchTo("opencode");
  expect(screen.getByTestId("process-panel-opencode")).toBeTruthy();
  expect(screen.queryByTestId("process-panel-codex")).toBeNull();
});

it("carries a glance line on each tab: process count and memory", async () => {
  installDispatch([
    group("codex", {
      processes: [summary()],
      totalMemoryBytes: 432_000_000,
    }),
    group("opencode"),
  ]);
  await renderView();

  expect(screen.getByTestId("process-tab-codex")?.textContent).toContain(
    "1 process · 432 MB",
  );
  expect(screen.getByTestId("process-tab-opencode")?.textContent).toContain(
    "No processes",
  );
});

it("shows each process with its memory and uptime beside the group totals", async () => {
  const pid = 4242;
  installDispatch([
    group("codex", {
      processes: [
        summary({ pid, name: "codex", memoryBytes: 300 }),
        summary({
          pid: 4243,
          name: "codex",
          memoryBytes: 100,
          command: null,
        }),
      ],
      totalMemoryBytes: 400,
      storage: measuredStorage({
        rows: [
          {
            label: "Session transcripts",
            path: "/sessions",
            bytes: 2_000,
            fileCount: 3,
          },
          {
            label: "Everything else",
            path: "/codex",
            bytes: 1_000,
            fileCount: 1,
          },
        ],
      }),
    }),
    group("opencode"),
  ]);
  await renderView();

  const panel = screen.getByTestId("process-panel-codex");
  expect(panel.contains(screen.getByTestId(`process-row-${pid}`))).toBe(true);
  expect(screen.getByTestId(`process-memory-${pid}`)?.textContent).toBe(
    "300 B",
  );
  expect(screen.getByTestId(`process-uptime-${pid}`)?.textContent).toContain(
    "1h",
  );
  expect(screen.getByTestId("process-totals-codex")?.textContent).toContain(
    "400 B",
  );
  expect(screen.getByTestId("process-totals-codex")?.textContent).toContain(
    "3 kB",
  );
  expect(screen.getByTestId("process-storage-codex")?.textContent).toContain(
    "Session transcripts",
  );
  expect(screen.getByTestId("process-storage-codex")?.textContent).toContain(
    "2 kB",
  );
});

it("renders rows in the report's order; ordering is the backend's decision", async () => {
  installDispatch([
    group("codex", {
      processes: [
        summary({ pid: 101, memoryBytes: 900 }),
        summary({ pid: 100, memoryBytes: 100 }),
      ],
    }),
    group("opencode"),
  ]);
  await renderView();

  const rows = screen.getAllByTestId(/^process-row-/);
  expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
    "process-row-101",
    "process-row-100",
  ]);
});

it("renders cpu share per process and summed in the group totals", async () => {
  const pid = 4242;
  installDispatch([
    group("codex", {
      processes: [summary({ pid, cpuUsage: 12.46 })],
      totalMemoryBytes: 432_000_000,
      totalCpuUsage: 12.46,
    }),
    group("opencode"),
  ]);
  await renderView();

  expect(screen.getByTestId(`process-cpu-${pid}`)?.textContent).toBe("12.5%");
  expect(screen.getByTestId("process-totals-codex")?.textContent).toContain(
    "CPU",
  );
  expect(screen.getByTestId("process-totals-codex")?.textContent).toContain(
    "12.5%",
  );
  expect(screen.getByTestId(`process-details-${pid}`)?.textContent).toContain(
    "CPU 12.5%",
  );
});

it("shows a dash for cpu the platform did not sample", async () => {
  const pid = 4242;
  installDispatch([
    group("codex", { processes: [summary({ pid })] }),
    group("opencode"),
  ]);
  await renderView();

  expect(screen.getByTestId(`process-cpu-${pid}`)?.textContent).toBe("—");
  expect(screen.getByTestId("process-totals-codex")?.textContent).toContain(
    "CPU",
  );
});

it("tags only abnormal process states", async () => {
  installDispatch([
    group("codex", {
      processes: [
        summary({ pid: 10, status: "zombie" }),
        summary({ pid: 11, status: null }),
        summary({ pid: 12, status: "stopped" }),
      ],
    }),
    group("opencode"),
  ]);
  await renderView();

  expect(screen.getByTestId("process-status-10")?.textContent).toBe("zombie");
  expect(screen.getByTestId("process-status-12")?.textContent).toBe("stopped");
  expect(screen.queryByTestId("process-status-11")).toBeNull();
});

it("renders listening endpoints with their interfaces, wildcard binds called out", async () => {
  installDispatch([
    group("codex"),
    group("opencode", {
      processes: [
        summary({
          pid: 5309,
          name: "opencode",
          command: "opencode serve --hostname 127.0.0.1",
          listeningPorts: [49374],
        }),
        summary({
          pid: 5310,
          name: "opencode",
          listeningPorts: [4096],
        }),
      ],
      ports: {
        state: "checked",
        listening: [
          { pid: 5309, port: 49374, address: "127.0.0.1" },
          { pid: 5310, port: 4096, address: "*" },
        ],
      },
    }),
  ]);
  await renderView();
  await switchTo("opencode");

  expect(screen.getByTestId("process-ports-5309")?.textContent).toBe(
    "127.0.0.1:49374",
  );
  expect(screen.getByTestId("process-ports-5310")?.textContent).toBe("*:4096");
  expect(screen.getByTestId("process-totals-opencode")?.textContent).toContain(
    "127.0.0.1:49374",
  );
  expect(screen.getByTestId("process-totals-opencode")?.textContent).toContain(
    "*:4096 · all interfaces",
  );
  expect(screen.getByTestId("process-details-5309")?.textContent).toContain(
    "Ports 127.0.0.1:49374",
  );
});

it("keeps every process fact in a compact shadcn table row", async () => {
  const pid = 5309;
  installDispatch([
    group("codex"),
    group("opencode", {
      processes: [
        summary({
          pid,
          name: "opencode",
          command: "opencode serve --hostname 127.0.0.1",
          cpuUsage: 3.2,
          listeningPorts: [49374],
        }),
      ],
      ports: {
        state: "checked",
        listening: [{ pid, port: 49374, address: null }],
      },
    }),
  ]);
  await renderView();
  await switchTo("opencode");

  const row = screen.getByTestId(`process-row-${pid}`);
  const table = row.closest("table");
  const compactDetails = row.querySelector(
    `[data-testid="process-details-${pid}"]`,
  );

  expect(table?.className).toContain("table-fixed");
  expect(compactDetails?.textContent).toContain(`PID ${pid}`);
  expect(compactDetails?.textContent).toContain("Ports :49374");
  expect(compactDetails?.textContent).toContain("CPU 3.2%");
  expect(compactDetails?.textContent).toContain("Uptime");
  expect(compactDetails?.className).toContain("2xl:hidden");
});

it("says none are listening when the scan checked and found nothing", async () => {
  installDispatch([group("codex"), group("opencode")]);
  await renderView();

  expect(screen.getByTestId("process-totals-codex")?.textContent).toContain(
    "None listening",
  );
  expect(screen.queryByTestId("process-ports-unavailable-codex")).toBeNull();
});

it("carries the reason when ports cannot be inspected at all", async () => {
  installDispatch([
    group("codex", {
      processes: [summary({ pid: 4242 })],
      ports: {
        state: "unavailable",
        reason: "Listening ports could not be inspected: program not found.",
      },
    }),
    group("opencode"),
  ]);
  await renderView();

  expect(
    screen.getByTestId("process-ports-unavailable-codex")?.textContent,
  ).toContain("could not be inspected");
  expect(screen.getByTestId("process-totals-codex")?.textContent).not.toContain(
    "None listening",
  );
  expect(screen.getByTestId("process-ports-4242")?.textContent).toBe("—");
});

it("renders the tool's recorded background service when its pid is live", async () => {
  installDispatch([
    group("codex"),
    group("opencode", {
      processes: [summary({ pid: 5309, name: "opencode" })],
      service: {
        version: "2.0.27",
        url: "http://127.0.0.1:49374",
        pid: 5309,
      },
    }),
  ]);
  await renderView();
  await switchTo("opencode");

  expect(
    screen.getByTestId("process-service-opencode")?.textContent,
  ).toBe("Background service · v2.0.27 · http://127.0.0.1:49374");
  expect(screen.queryByTestId("process-service-codex")).toBeNull();
});

it("names the databases inside the storage breakdown", async () => {
  installDispatch([
    group("codex", {
      storage: measuredStorage({
        totalBytes: 500_000_000,
        totalFiles: 95,
        rows: [
          {
            label: "Databases (SQLite)",
            path: "state_5.sqlite, thread_history_1.sqlite, goals_1.sqlite",
            bytes: 60_000_000,
            fileCount: 5,
          },
          {
            label: "Everything else",
            path: "/Users/dev/.codex",
            bytes: 440_000_000,
            fileCount: 90,
          },
        ],
      }),
    }),
    group("opencode"),
  ]);
  await renderView();

  const storage = screen.getByTestId("process-storage-codex");
  expect(storage.textContent).toContain("Databases (SQLite)");
  expect(storage.textContent).toContain("state_5.sqlite");
  expect(storage.textContent).toContain("60 MB");
  const databasePath = screen
    .getAllByTestId("process-storage-path-codex")
    .find((element) => element.textContent?.includes("state_5.sqlite"));
  expect(databasePath).toBeTruthy();
  expect(databasePath?.className).toContain("break-words");
  expect(databasePath?.className).not.toContain("truncate");

  const databaseRow = screen
    .getAllByTestId("process-storage-row-codex")
    .find((element) => element.textContent?.includes("Databases (SQLite)"));
  const value = databaseRow?.querySelector(
    '[data-testid="process-storage-value-codex"]',
  );
  expect(databaseRow?.className).toContain("grid");
  expect(value?.className).toContain("shrink-0");
  expect(value?.className).toContain("text-right");
  expect(value?.className).toContain("whitespace-nowrap");
});

it("scales a share bar to each row's fraction of the measured total", async () => {
  installDispatch([
    group("codex", {
      storage: measuredStorage({
        totalBytes: 500,
        rows: [
          { label: "Session transcripts", path: "/sessions", bytes: 450, fileCount: 9 },
          { label: "Everything else", path: "/codex", bytes: 50, fileCount: 1 },
        ],
      }),
    }),
    group("opencode"),
  ]);
  await renderView();

  const shares = screen.getAllByTestId("process-storage-share-codex");
  expect(shares.map((share) => share.style.width)).toEqual(["90%", "10%"]);
});

it("carries relocated footprint outside the measured total", async () => {
  installDispatch([
    group("codex", {
      storage: measuredStorage({
        totalBytes: 30,
        rows: [
          { label: "Everything else", path: "/Users/dev/.codex", bytes: 30, fileCount: 1 },
        ],
        externalRows: [
          {
            label: "Databases (SQLite) — relocated via CODEX_SQLITE_HOME",
            path: "state_5.sqlite",
            bytes: 400,
            fileCount: 1,
          },
        ],
      }),
    }),
    group("opencode"),
  ]);
  await renderView();

  const external = screen.getByTestId("process-storage-external-codex");
  expect(external.textContent).toContain("Outside the data directory");
  expect(external.textContent).toContain("not part of the total above");
  expect(external.textContent).toContain("400 B");
  expect(
    screen.getAllByTestId("process-storage-share-codex").length,
  ).toBe(1);
});

it("renders an absent footprint as its reason, never as zero bytes", async () => {
  installDispatch([
    group("codex"),
    group("opencode", {
      storage: {
        state: "absent",
        reason:
          "OpenCode has not created `/Users/dev/.local/share/opencode` yet.",
      },
    }),
  ]);
  await renderView();
  await switchTo("opencode");

  const absent = screen.getByTestId("process-storage-absent-opencode");
  expect(absent.textContent).toContain("has not created");
  expect(absent.textContent).not.toContain("0 B");
  expect(screen.queryByTestId("process-storage-opencode")).toBeNull();
});

it("says explicitly when a group has nothing running", async () => {
  installDispatch([
    group("codex"),
    group("opencode", {
      processes: [],
      storage: measuredStorage({}),
    }),
  ]);
  await renderView();
  await switchTo("opencode");

  expect(screen.getByTestId("process-empty-opencode")?.textContent).toContain(
    "No OpenCode processes",
  );
});

it("marks the reading's age and the toolchain summary below the panels", async () => {
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: ({ request }: { request: Request }) => {
      if (request.type !== "processInsights") {
        return { type: "failure", error: { kind: "protocolMismatch", message: "x" } };
      }
      return {
        type: "processInsights",
        insights: {
          fetchedAt: Date.now() - 30_000,
          groups: [
            group("codex", {
              processes: [summary()],
              totalMemoryBytes: 432_000_000,
              storage: measuredStorage({ totalBytes: 500_000_000 }),
            }),
            group("opencode"),
          ],
        },
      };
    },
  };
  await renderView();

  const pill = screen.getByTestId("freshness-pill");
  expect(pill.getAttribute("data-freshness")).toBe("live");
  expect(pill.textContent).toContain("Read just now");

  expect(screen.getByTestId("process-summary")?.textContent).toBe(
    "2 groups · 1 process · 432 MB memory · 500 MB on disk · measured roots only",
  );
});

it("turns the freshness pill stale past fifteen minutes", async () => {
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: ({ request }: { request: Request }) => {
      if (request.type !== "processInsights") {
        return { type: "failure", error: { kind: "protocolMismatch", message: "x" } };
      }
      return {
        type: "processInsights",
        insights: {
          fetchedAt: Date.now() - 16 * 60_000,
          groups: [group("codex"), group("opencode")],
        },
      };
    },
  };
  await renderView();

  const pill = screen.getByTestId("freshness-pill");
  expect(pill.getAttribute("data-freshness")).toBe("stale");
  expect(pill.textContent).toContain("Stale · read");

  expect(screen.getByTestId("process-summary")?.textContent).toBe(
    "2 groups · 0 processes · 0 B memory · 0 B on disk · measured roots only",
  );
});

it("explains cpu above one hundred percent in the read-only note", async () => {
  installDispatch([group("codex"), group("opencode")]);
  await renderView();

  expect(
    screen.getByTestId("process-readonly-note")?.textContent,
  ).toContain("100%");
});

it("marks a re-read in flight instead of rendering it as fresh", async () => {
  installDispatch([group("codex"), group("opencode")]);
  await renderView();

  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: () =>
      new Promise(() => {
        return undefined;
      }),
  };
  fireEvent.click(screen.getByTestId("refresh-processes-codex"));

  expect(await screen.findByTestId("process-refreshing")).toBeTruthy();
  expect(screen.getByTestId("process-panel-codex")).toBeTruthy();
});

it("shows the read's own reason and a re-read when the read fails", async () => {
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: ({ request }: { request: Request }) => {
      if (request.type !== "processInsights") {
        return { type: "failure", error: { kind: "protocolMismatch", message: "x" } };
      }
      return {
        type: "failure",
        error: {
          kind: "internal",
          message: "the process table was unreadable",
        },
      };
    },
  };
  const { ProcessView } = await import("~/components/views/process-view");
  render(
    createElement(ProcessView as ComponentType<{ visible: boolean }>, {
      visible: true,
    }),
  );

  const error = await screen.findByTestId("process-error");
  expect(error.textContent).toContain("the process table was unreadable");
  const retry = screen.getByTestId("retry-processes");
  expect(retry).toBeTruthy();

  installDispatch([group("codex"), group("opencode")]);
  fireEvent.click(retry);
  expect(await screen.findByTestId("process-panel-codex")).toBeTruthy();
});

it("offers no control beyond view tabs and refresh, because the capability has no write", async () => {
  installDispatch([group("codex"), group("opencode")]);
  await renderView();

  const buttons = screen.getAllByRole("button");
  const testids = buttons.map(
    (button) => button.getAttribute("data-testid") ?? "",
  );
  expect(testids.length).toBeGreaterThan(0);
  for (const testid of testids) {
    expect(
      testid.startsWith("refresh-processes-") || testid.startsWith("process-tab-"),
    ).toBe(true);
  }
});
