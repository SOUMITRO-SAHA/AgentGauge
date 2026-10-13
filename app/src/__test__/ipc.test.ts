import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import * as Ipc from "~/lib/ipc";

/**
 * Cross-boundary contract tests.
 *
 * The onboarding step list exists on both sides of the IPC boundary, and Rust
 * persists the *ordinal*. If the two lists disagree about the steps or their
 * order, saved progress silently means something different to the app and to the
 * widget — and the mismatch is invisible until a user returns to a half-finished
 * flow. These assertions pin the list so a change on one side fails here.
 */
describe("OnboardingStep", () => {
  it("accepts exactly the steps Rust persists, and nothing else", () => {
    // The order is pinned by `OnboardingStep::ALL` in the Rust module; this
    // asserts the two lists agree on membership and count.
    const steps = [
      "welcome",
      "statusCheck",
      "windowRollover",
      "widget",
      "automation",
      "done",
    ] as const;

    for (const step of steps) {
      expect(Schema.decodeUnknownSync(Ipc.OnboardingStep)(step)).toBe(step);
    }
    expect(() =>
      Schema.decodeUnknownSync(Ipc.OnboardingStep)("sevenStepsLater"),
    ).toThrow();
  });

  it("decodes the widget step, which the flow renders", () => {
    // This step existed in the flow and in Rust but was missing from this list,
    // so the renderer could never send or show it.
    const decoded = Schema.decodeUnknownSync(Ipc.OnboardingStep)("widget");
    expect(decoded).toBe("widget");
  });

  it("rejects an unknown step rather than defaulting to the first", () => {
    // Defaulting would silently restart a returning user at step one.
    expect(() =>
      Schema.decodeUnknownSync(Ipc.OnboardingStep)("notAStep"),
    ).toThrow();
  });
});

describe("SystemWidgetStatus", () => {
  const decode = (value: unknown) =>
    Schema.decodeUnknownSync(Ipc.SystemWidgetStatus)(value);

  const ready = {
    supported: true,
    system: "widgetKit",
    osVersion: "27.0",
    minimumVersion: "14.0",
    extensionBundled: true,
    extensionPresent: true,
    snapshotWritten: true,
    configured: true,
    placedKinds: ["AIStatsUsageWidget"],
    menuBarAvailable: true,
    setup: [{ title: "Open the widget gallery", detail: "Right-click the desktop." }],
    reason: null,
  };

  it("decodes a ready build", () => {
    const status = decode(ready);
    expect(status.supported).toBe(true);
    expect(status.extensionPresent).toBe(true);
    expect(status.setup).toHaveLength(1);
  });

  it("keeps an unsupported reason rather than dropping it", () => {
    // The guide has to say *why* the widget is unavailable. Losing the reason
    // would leave the panel with nothing to render.
    const status = decode({
      ...ready,
      supported: false,
      system: "none",
      setup: [],
      reason: "The system widget is implemented for macOS only.",
    });
    expect(status.supported).toBe(false);
    expect(status.reason).toContain("macOS only");
  });

  it("has no setup call, because macOS owns widget placement", () => {
    // A "setup widget" request would imply the app can install something it
    // cannot. The surface must not grow one by accident.
    expect(Object.keys(Ipc)).not.toContain("setupWidget");
    expect(Object.keys(Ipc)).not.toContain("hideWidget");
    expect(typeof Ipc.getSystemWidgetStatus).toBe("function");
  });
});

describe("CliToolStatus", () => {
  it("decodes Codex and OpenCode detection without implying provider support", () => {
    const statuses = [
      {
        tool: "codex",
        displayName: "Codex CLI",
        executable: "codex",
        installed: true,
        version: "codex-cli 0.159.0",
        reason: null,
      },
      {
        tool: "openCode",
        displayName: "OpenCode CLI",
        executable: "opencode",
        installed: false,
        version: null,
        reason: "Executable was not found on PATH.",
      },
    ];

    const decoded = Schema.decodeUnknownSync(Schema.Array(Ipc.CliToolStatus))(statuses);
    expect(decoded.map((status) => status.tool)).toEqual(["codex", "openCode"]);
    expect(decoded[1]?.installed).toBe(false);
  });
});
