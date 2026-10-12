import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let releaseRead: (() => void) | undefined;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  releaseRead?.();
  releaseRead = undefined;
  delete (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__;
  cleanup();
});

it("reserves the widget guidance shape while system support is checked", async () => {
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: () =>
      new Promise((resolve: (value: unknown) => void) => {
        releaseRead = () =>
          resolve({
            type: "systemWidget",
            status: {
              supported: true,
              system: "widgetKit",
              osVersion: "26.0",
              minimumVersion: "14.0",
              extensionBundled: true,
              extensionPresent: true,
              snapshotWritten: true,
              configured: null,
              menuBarAvailable: true,
              setup: [
                { title: "Open the gallery", detail: "Choose AgentGauge." },
              ],
              reason: null,
            },
          });
      }),
  };
  const { SystemWidgetGuide } = await import("~/components/widget/system-widget-guide");
  render(createElement(SystemWidgetGuide));

  const skeleton = await screen.findByTestId("widget-loading-skeleton");
  expect(skeleton.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(4);

  releaseRead?.();
  expect(await screen.findByTestId("widget-setup-steps")).toBeTruthy();
  expect(screen.queryByTestId("widget-loading-skeleton")).toBeNull();
});
