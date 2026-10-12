import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  expect(loading.querySelectorAll('[data-testid="status-loading-row"]')).toHaveLength(2);

  releaseRead?.();
  expect(await screen.findByTestId("cli-codex")).toBeTruthy();
  expect(screen.queryByTestId("status-loading")).toBeNull();
});

it("shows the CLI skeleton until a requested re-check completes", async () => {
  let readCount = 0;
  const response = (version: string) => ({
    type: "cliDetections",
    tools: [
      {
        tool: "codex",
        displayName: "Codex CLI",
        executable: "codex",
        installed: true,
        version,
        reason: null,
      },
      {
        tool: "openCode",
        displayName: "OpenCode CLI",
        executable: "opencode",
        installed: false,
        version: null,
        reason: "`opencode` is not available on this system.",
      },
    ],
  });
  (window as unknown as { __wdio_mocks__?: unknown }).__wdio_mocks__ = {
    dispatch: () => {
      readCount += 1;
      if (readCount === 1) return response("1.0.0");
      return new Promise((resolve: (value: unknown) => void) => {
        releaseRead = () => resolve(response("2.0.0"));
      });
    },
  };
  const { ProviderStatusCard } = await import("~/components/usage/provider-status-card");
  render(createElement(ProviderStatusCard));

  expect((await screen.findByTestId("codex-version")).textContent).toBe("1.0.0");
  fireEvent.click(screen.getByTestId("refresh-provider"));

  const loading = await screen.findByTestId("status-loading");
  expect(loading.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(4);
  expect(loading.querySelectorAll('[data-testid="status-loading-row"]')).toHaveLength(2);
  expect(
    loading.querySelectorAll('[data-testid="status-loading-install-command"]'),
  ).toHaveLength(1);
  expect(screen.queryByTestId("cli-codex")).toBeNull();
  expect(screen.getByTestId("refresh-provider").hasAttribute("disabled")).toBe(
    true,
  );

  releaseRead?.();
  expect((await screen.findByTestId("codex-version")).textContent).toBe("2.0.0");
  expect(screen.getByTestId("cli-opencode").textContent).toContain("not found");
  expect(screen.queryByTestId("status-loading")).toBeNull();
  expect(screen.getByTestId("refresh-provider").hasAttribute("disabled")).toBe(
    false,
  );
});
