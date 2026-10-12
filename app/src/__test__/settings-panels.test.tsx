import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const APP_INFO_RESPONSE = {
  type: "appInfo",
  info: {
    appVersion: "0.2.0",
    os: "macos",
    arch: "aarch64",
    osVersion: "15.3.1",
    diagnostics:
      "### System diagnostics\n\n- AgentGauge: 0.2.0\n- System: macOS 15.3.1 (aarch64)",
    links: {
      repository: "https://github.com/SOUMITRO-SAHA/AgentGauge",
      releases: "https://github.com/SOUMITRO-SAHA/AgentGauge/releases",
      bugReport:
        "https://github.com/SOUMITRO-SAHA/AgentGauge/issues/new?template=bug_report.yml&diagnostics=x",
      featureRequest:
        "https://github.com/SOUMITRO-SAHA/AgentGauge/issues/new?template=feature_request.yml",
      funding: [
        {
          label: "GitHub Sponsors",
          url: "https://github.com/sponsors/SOUMITRO-SAHA",
        },
        { label: "Patreon", url: "https://www.patreon.com/SOUMITROSAHA" },
      ],
    },
  },
};

type DispatchCall = { type: string; url?: string };

let calls: DispatchCall[];

const SYSTEM_WIDGET_RESPONSE = {
  type: "systemWidget",
  status: {
    supported: true,
    system: "widgetKit",
    osVersion: null,
    minimumVersion: "14",
    extensionBundled: false,
    extensionPresent: false,
    snapshotWritten: false,
    configured: null,
    menuBarAvailable: false,
    setup: [],
    reason: null,
  },
};

function mockDispatch(response: unknown = APP_INFO_RESPONSE) {
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: (args: { request: DispatchCall }) => {
      calls.push(args.request);
      if (args.request.type === "appInfo") {
        return Promise.resolve(response);
      }
      if (args.request.type === "systemWidgetStatus") {
        return Promise.resolve(SYSTEM_WIDGET_RESPONSE);
      }
      return Promise.resolve({ type: "linkOpened" });
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  calls = [];
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  delete (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__;
  cleanup();
});

async function lastCall(): Promise<DispatchCall> {
  await Promise.resolve();
  await Promise.resolve();
  return calls[calls.length - 1];
}

it("the about panel states the build facts and opens its links through the backend", async () => {
  mockDispatch();
  const { AboutPanel } = await import("~/components/settings/about-panel");
  render(createElement(AboutPanel));

  expect((await screen.findByTestId("about-version")).textContent).toContain("0.2.0");
  expect(screen.getByTestId("about-mark")).toBeTruthy();
  const system = screen.getByTestId("about-system").textContent ?? "";
  expect(system).toContain("macOS 15.3.1");
  expect(system).toContain("aarch64");

  fireEvent.click(screen.getByTestId("about-link-repository"));
  expect(await lastCall()).toEqual({
    type: "openLink",
    url: "https://github.com/SOUMITRO-SAHA/AgentGauge",
  });

  fireEvent.click(screen.getByTestId("about-link-releases"));
  expect(await lastCall()).toEqual({
    type: "openLink",
    url: "https://github.com/SOUMITRO-SAHA/AgentGauge/releases",
  });
});

it("the about panel names its failure instead of rendering invented facts", async () => {
  mockDispatch({ type: "failure", error: { kind: "storage", message: "no" } });
  const { AboutPanel } = await import("~/components/settings/about-panel");
  render(createElement(AboutPanel));

  expect(await screen.findByTestId("about-failed")).toBeTruthy();
  expect(screen.queryByTestId("about-version")).toBeNull();
});

it("the feedback panel files through the prefilled urls and copies diagnostics", async () => {
  mockDispatch();
  const { FeedbackPanel } = await import("~/components/settings/feedback-panel");
  render(createElement(FeedbackPanel));
  await screen.findByTestId("feedback-bug");

  fireEvent.click(screen.getByTestId("feedback-bug"));
  expect(await lastCall()).toEqual({
    type: "openLink",
    url: APP_INFO_RESPONSE.info.links.bugReport,
  });

  fireEvent.click(screen.getByTestId("feedback-feature"));
  expect(await lastCall()).toEqual({
    type: "openLink",
    url: APP_INFO_RESPONSE.info.links.featureRequest,
  });

  fireEvent.click(screen.getByTestId("feedback-copy"));
  await Promise.resolve();
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
    APP_INFO_RESPONSE.info.diagnostics,
  );
});

it("the settings screen pairs the short panels around the full-width core", async () => {
  mockDispatch();
  const { SettingsView } = await import("~/components/views/settings-view");
  render(createElement(SettingsView, { visible: true }));

  const screen_ = await screen.findByTestId("view-settings");
  const row = await screen.findByTestId("settings-info-row");
  expect(row.contains(screen.getByTestId("about-panel"))).toBe(true);
  expect(row.contains(screen.getByTestId("feedback-panel"))).toBe(true);
  expect(row.contains(screen.getByTestId("widget-panel"))).toBe(false);
  expect(screen_.contains(screen.getByTestId("widget-panel"))).toBe(true);
  expect(screen_.contains(screen.getByTestId("support-panel"))).toBe(true);
  expect(screen_.contains(screen.getByTestId("settings-about"))).toBe(true);
});

it("the support panel leads with the minimum and a highlighted primary action", async () => {
  mockDispatch();
  const { SupportPanel } = await import("~/components/settings/support-panel");
  render(createElement(SupportPanel));

  const message = await screen.findByTestId("support-message");
  expect(message.textContent).toContain("$1");

  const sponsors = screen.getByTestId("support-link-github-sponsors");
  expect(sponsors.textContent).toContain("Sponsor");
  expect(sponsors.getAttribute("data-variant")).toBe("default");
  const patreon = screen.getByTestId("support-link-patreon");
  expect(patreon.textContent).toContain("Patreon");
  expect(patreon.getAttribute("data-variant")).toBe("outline");

  fireEvent.click(patreon);
  expect(await lastCall()).toEqual({
    type: "openLink",
    url: "https://www.patreon.com/SOUMITROSAHA",
  });

  fireEvent.click(sponsors);
  expect(await lastCall()).toEqual({
    type: "openLink",
    url: "https://github.com/sponsors/SOUMITRO-SAHA",
  });
});
