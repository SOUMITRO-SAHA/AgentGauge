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

function mockDispatch(response: unknown = APP_INFO_RESPONSE) {
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: (args: { request: DispatchCall }) => {
      calls.push(args.request);
      if (args.request.type === "appInfo") {
        return Promise.resolve(response);
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

it("the support panel lists the live funding destinations as links", async () => {
  mockDispatch();
  const { SupportPanel } = await import("~/components/settings/support-panel");
  render(createElement(SupportPanel));

  const sponsors = await screen.findByTestId("support-link-github-sponsors");
  expect(sponsors.textContent).toContain("GitHub Sponsors");
  const patreon = screen.getByTestId("support-link-patreon");
  expect(patreon.textContent).toContain("Patreon");

  fireEvent.click(patreon);
  expect(await lastCall()).toEqual({
    type: "openLink",
    url: "https://www.patreon.com/SOUMITROSAHA",
  });
});
