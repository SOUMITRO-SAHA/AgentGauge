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

it("shapes CLI detection rows while the first check is pending", async () => {
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: () =>
      new Promise((resolve: (value: unknown) => void) => {
        releaseRead = () =>
          resolve({
            type: "cliDetections",
            tools: [
              {
                tool: "codex",
                displayName: "Codex CLI",
                executable: "codex",
                installed: true,
                version: "1.0.0",
                reason: null,
              },
              {
                tool: "openCode",
                displayName: "OpenCode CLI",
                executable: "opencode",
                installed: true,
                version: "1.0.0",
                reason: null,
              },
            ],
          });
      }),
  };
  const { ProviderStatusCard } = await import("~/components/usage/provider-status-card");
  render(createElement(ProviderStatusCard));

  const loading = await screen.findByTestId("status-loading");
  expect(loading.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(4);

  releaseRead?.();
  expect(await screen.findByTestId("cli-codex")).toBeTruthy();
  expect(screen.queryByTestId("status-loading")).toBeNull();
});
