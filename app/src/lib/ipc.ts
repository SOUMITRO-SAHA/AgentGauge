/**
 * The IPC boundary.
 *
 * `invoke` is called in exactly this file, once, wrapped in an Effect via
 * `Effect.tryPromise`. No component calls it directly, and nothing else in the
 * client knows the command name.
 *
 * The shape mirrors `app/src-tauri/src/shared/protocol.rs`: a tagged request in,
 * a tagged response out. Both enums are exhaustive, so adding a capability in
 * Rust surfaces here as a compile error rather than as a silent `undefined` at
 * runtime.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * A failure to reach the Rust side at all: the bridge is unavailable, or the
 * call was aborted.
 *
 * Distinct from a protocol-level `failure` response, so the UI can tell "the
 * app is broken" from "the provider said no".
 */
export class IpcError extends Schema.TaggedError<IpcError>()("IpcError", {
  message: Schema.String,
  command: Schema.String,
}) {}

/**
 * The app answered, but could not satisfy the request.
 *
 * `kind` mirrors the Rust `ErrorKind` tags, so callers branch on a stable
 * discriminator instead of matching message text.
 */
export class AppFailure extends Schema.TaggedError<AppFailure>()("AppFailure", {
  message: Schema.String,
  kind: Schema.String,
}) {}

export type AppError = IpcError | AppFailure;

/** The single command name. Every capability goes through it. */
const DISPATCH = "dispatch";

/** The shape the e2e harness installs its command mocks under. */
type MockRegistry = Record<string, (args: unknown) => unknown>;

/**
 * Calls the Rust side.
 *
 * The mock registry is consulted first, and that is deliberate. The harness
 * installs mocks on `window.__wdio_mocks__` and patches
 * `window.__TAURI__.core.invoke` to read them — but that patch is a
 * `defineProperty` on a Tauri-managed object, and on this WKWebView build it
 * silently does not take. Routing through the registry here means a mock is
 * honoured whether or not the harness patch landed, so a spec cannot pass
 * against live provider data while believing it mocked something.
 *
 * In a real build the registry is absent, so this is a single property read and
 * the call goes straight to Rust.
 */
async function invoke(
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  // Read from `window` explicitly rather than `globalThis`: the harness installs
  // the registry on the page's `window`, and in a bundled module `globalThis`
  // is the same object — but naming `window` makes that contract explicit
  // instead of relying on the alias holding across the bundler.
  const mocks = (window as { __wdio_mocks__?: MockRegistry }).__wdio_mocks__;
  const mock = mocks?.[command];
  if (typeof mock === "function") {
    return mock(args);
  }

  const core = (
    window as {
      __TAURI__?: {
        core?: { invoke?: (c: string, a?: unknown) => Promise<unknown> };
      };
    }
  ).__TAURI__?.core;

  if (core?.invoke) {
    return core.invoke(command, args);
  }

  const { invoke: fallback } = await import("@tauri-apps/api/core");
  return fallback(command, args);
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export const ProviderKind = Schema.Literals(["codex"]);
export type ProviderKind = typeof ProviderKind.Type;

export const Freshness = Schema.Literals(["live", "cached", "stale", "unavailable"]);
export type Freshness = typeof Freshness.Type;

/**
 * `unknown` is not `allowed`. The provider documents that a null permission
 * means "unavailable" and must never be read as healthy.
 */
export const UsagePermission = Schema.Literals(["allowed", "blocked", "unknown"]);
export type UsagePermission = typeof UsagePermission.Type;

export const PlanKind = Schema.Literals([
  "free",
  "go",
  "plus",
  "pro",
  "proLite",
  "proMax",
  "team",
  "business",
  "enterprise",
  "edu",
  "other",
  "unknown",
]);
export type PlanKind = typeof PlanKind.Type;

export const UsageWindow = Schema.Struct({
  label: Schema.String,
  usedPercent: Schema.Number,
  durationMins: Schema.NullOr(Schema.Number),
  /** Unix **seconds**: the provider's own unit, converted only at render. */
  resetsAt: Schema.NullOr(Schema.Number),
  /** Precomputed in Rust so no surface can render an inverted bar. */
  remainingPercent: Schema.Number,
});
export type UsageWindow = typeof UsageWindow.Type;

/**
 * A reading with its provenance attached.
 *
 * `freshness` and `reason` are what make it impossible to render a number
 * without saying where it came from: an `unavailable` snapshot always carries a
 * reason, so "could not fetch" can never be mistaken for zero.
 */
export const UsageSnapshot = Schema.Struct({
  provider: ProviderKind,
  freshness: Freshness,
  /** Epoch milliseconds. */
  fetchedAt: Schema.NullOr(Schema.Number),
  source: Schema.String,
  reason: Schema.NullOr(Schema.String),
  plan: Schema.NullOr(PlanKind),
  permission: UsagePermission,
  windows: Schema.Array(UsageWindow),
  fiveHour: Schema.NullOr(UsageWindow),
  weekly: Schema.NullOr(UsageWindow),
});
export type UsageSnapshot = typeof UsageSnapshot.Type;

export const ProviderStatus = Schema.Struct({
  kind: ProviderKind,
  executable: Schema.String,
  installed: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
});
export type ProviderStatus = typeof ProviderStatus.Type;

export const AutomationState = Schema.Struct({
  running: Schema.Boolean,
  usage: Schema.NullOr(UsageSnapshot),
  lastPolledAt: Schema.NullOr(Schema.Number),
  rolledOver: Schema.Boolean,
  observedResetsAt: Schema.NullOr(Schema.Number),
  rolledOverAt: Schema.NullOr(Schema.Number),
  nextPollAt: Schema.NullOr(Schema.Number),
});
export type AutomationState = typeof AutomationState.Type;

/**
 * Onboarding steps, in order.
 *
 * Must match `OnboardingStep` in the Rust backend, including the count: the
 * ordinal is persisted, so a step present on one side and missing on the other
 * makes saved progress mean something different to each.
 */
export const OnboardingStep = Schema.Literals([
  "welcome",
  "statusCheck",
  "windowRollover",
  "widget",
  "automation",
  "done",
]);
export type OnboardingStep = typeof OnboardingStep.Type;

export const OnboardingProgress = Schema.Struct({
  step: OnboardingStep,
  dismissed: Schema.Boolean,
  index: Schema.Number,
  total: Schema.Number,
  /**
   * Whether the flow should be shown on launch. Decided in Rust so the rule
   * lives beside the persisted state and the renderer cannot drift from it.
   */
  visible: Schema.Boolean,
});
export type OnboardingProgress = typeof OnboardingProgress.Type;

/**
 * What the setup guide needs to know about the system's own widget.
 *
 * `supported` is false off macOS and below macOS 14, and `reason` says which —
 * so the UI never has to infer availability from a missing field.
 */
export const SystemWidgetStatus = Schema.Struct({
  supported: Schema.Boolean,
  system: Schema.Union([Schema.Literal("widgetKit"), Schema.Literal("none")]),
  osVersion: Schema.NullOr(Schema.String),
  minimumVersion: Schema.String,
  extensionBundled: Schema.Boolean,
  extensionPresent: Schema.Boolean,
  snapshotWritten: Schema.Boolean,
  menuBarAvailable: Schema.Boolean,
  setup: Schema.Array(
    Schema.Struct({ title: Schema.String, detail: Schema.String }),
  ),
  reason: Schema.NullOr(Schema.String),
});
export type SystemWidgetStatus = typeof SystemWidgetStatus.Type;

export const PingOutcome = Schema.Struct({
  accepted: Schema.Boolean,
  reply: Schema.String,
  usage: Schema.NullOr(UsageSnapshot),
  reason: Schema.NullOr(Schema.String),
});
export type PingOutcome = typeof PingOutcome.Type;

// ---------------------------------------------------------------------------
// The protocol
// ---------------------------------------------------------------------------

const ErrorPayload = Schema.Struct({ kind: Schema.String, message: Schema.String });

/**
 * Every capability the renderer can invoke.
 *
 * `Schema.Union` over tagged structs rather than one wide struct, so an unknown
 * tag is a decode failure instead of a partially-populated request.
 */
export const AppRequest = Schema.Union([
  Schema.Struct({ type: Schema.Literal("hello") }),
  Schema.Struct({ type: Schema.Literal("providerStatus") }),
  Schema.Struct({ type: Schema.Literal("readUsage") }),
  Schema.Struct({ type: Schema.Literal("readUsageFor"), provider: ProviderKind }),
  Schema.Struct({ type: Schema.Literal("readPlan"), provider: ProviderKind }),
  Schema.Struct({
    type: Schema.Literal("sendPing"),
    prompt: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("automationState") }),
  Schema.Struct({ type: Schema.Literal("startAutomation") }),
  Schema.Struct({ type: Schema.Literal("stopAutomation") }),
  Schema.Struct({ type: Schema.Literal("acknowledgeRollover") }),
  Schema.Struct({ type: Schema.Literal("onboardingProgress") }),
  Schema.Struct({
    type: Schema.Literal("setOnboardingStep"),
    step: OnboardingStep,
    dismissed: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("systemWidgetStatus") }),
]);
export type AppRequest = typeof AppRequest.Type;

/**
 * Every response the app can send, mirroring the Rust `AppResponse`.
 *
 * The `failure` arm is what turns a Rust error into a typed value rather than a
 * thrown string.
 */
export const AppResponse = Schema.Union([
  Schema.Struct({ type: Schema.Literal("protocol"), version: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("providerStatuses"),
    providers: Schema.Array(ProviderStatus),
  }),
  Schema.Struct({
    type: Schema.Literal("usage"),
    snapshots: Schema.Array(UsageSnapshot),
  }),
  Schema.Struct({ type: Schema.Literal("plan"), plan: Schema.NullOr(PlanKind) }),
  Schema.Struct({ type: Schema.Literal("ping"), outcome: PingOutcome }),
  Schema.Struct({ type: Schema.Literal("automation"), state: AutomationState }),
  Schema.Struct({
    type: Schema.Literal("onboarding"),
    progress: OnboardingProgress,
  }),
  Schema.Struct({ type: Schema.Literal("systemWidget"), status: SystemWidgetStatus }),
  Schema.Struct({ type: Schema.Literal("failure"), error: ErrorPayload }),
]);
export type AppResponse = typeof AppResponse.Type;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Sends a request and returns the decoded response.
 *
 * `invoke` resolves `unknown`, so decoding is mandatory: a cast would let a
 * protocol change reach a component as a malformed object.
 */
const decodeResponse = Schema.decodeUnknownPromise(AppResponse);

export const request = (
  payload: AppRequest,
): Effect.Effect<AppResponse, AppError> =>
  Effect.flatMap(
    Effect.tryPromise({
      try: (signal) => invoke(DISPATCH, { request: payload, signal }),
      catch: (cause) => new IpcError({ message: describe(cause), command: DISPATCH }),
    }),
    (raw) =>
      Effect.flatMap(
        Effect.tryPromise({
          try: () => decodeResponse(raw),
          catch: (cause) =>
            new IpcError({
              message: `The ${payload.type} response could not be read: ${describe(cause)}`,
              command: DISPATCH,
            }),
        }),
        (response) =>
          // A `failure` response is an error value, not a transport problem.
          // Raising it here means callers handle one `AppError` type.
          response.type === "failure"
            ? Effect.fail(new AppFailure(response.error))
            : Effect.succeed(response),
      ),
  );

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "The request failed for an unknown reason.";
}

/**
 * Narrows a response to one variant, failing on a mismatch.
 *
 * A protocol drift between the renderer and the binary shows up here as a typed
 * error naming both types, not as `undefined` reaching a component.
 */
export function expectType<T extends AppResponse["type"]>(
  response: AppResponse,
  type: T,
): Extract<AppResponse, { type: T }> {
  if (response.type !== type) {
    throw new AppFailure({
      kind: "protocolMismatch",
      message: `Expected a \`${type}\` response but received \`${response.type}\`.`,
    });
  }
  return response as Extract<AppResponse, { type: T }>;
}

// ---------------------------------------------------------------------------
// Capabilities
//
// Thin wrappers so call sites read as intent, not as protocol plumbing.
// ---------------------------------------------------------------------------

/** Handshake. Answers with the protocol version. */
export const hello = () =>
  request({ type: "hello" }).pipe(
    Effect.map((response) => expectType(response, "protocol").version),
  );

/** Probes every provider without starting a long-lived process. */
export const getProviderStatus = () =>
  request({ type: "providerStatus" }).pipe(
    Effect.map((response) => expectType(response, "providerStatuses").providers),
  );

/**
 * Reads usage for every provider.
 *
 * A provider that fails becomes an `unavailable` snapshot in Rust, so one broken
 * provider never blanks the whole dashboard.
 */
export const getUsage = () =>
  request({ type: "readUsage" }).pipe(
    Effect.map((response) => expectType(response, "usage").snapshots),
  );

/** Reads usage for one provider. */
export const getUsageFor = (provider: ProviderKind) =>
  request({ type: "readUsageFor", provider }).pipe(
    Effect.map((response) => expectType(response, "usage").snapshots),
  );

/** Reads the account plan tier, which an API-key account does not have. */
export const getPlan = (provider: ProviderKind) =>
  request({ type: "readPlan", provider }).pipe(
    Effect.map((response) => expectType(response, "plan").plan),
  );

/**
 * Sends the minimal prompt that proves the account can still answer.
 *
 * This spends quota. Nothing may call it on a timer the user did not opt into.
 */
export const sendPing = (prompt?: string) =>
  request({ type: "sendPing", prompt }).pipe(
    Effect.map((response) => expectType(response, "ping").outcome),
  );

export const getAutomationState = () =>
  request({ type: "automationState" }).pipe(
    Effect.map((response) => expectType(response, "automation").state),
  );

/** Starts the watcher. Idempotent, so a double call cannot double-poll. */
export const startAutomation = () =>
  request({ type: "startAutomation" }).pipe(
    Effect.map((response) => expectType(response, "automation").state),
  );

export const stopAutomation = () =>
  request({ type: "stopAutomation" }).pipe(
    Effect.map((response) => expectType(response, "automation").state),
  );

/** Clears a detected rollover once the UI has shown it. */
export const acknowledgeRollover = () =>
  request({ type: "acknowledgeRollover" }).pipe(
    Effect.map((response) => expectType(response, "automation").state),
  );

export const getOnboardingProgress = () =>
  request({ type: "onboardingProgress" }).pipe(
    Effect.map((response) => expectType(response, "onboarding").progress),
  );

/** Persists onboarding progress. A failure is reported, not swallowed. */
export const setOnboardingStep = (step: OnboardingStep, dismissed: boolean) =>
  request({ type: "setOnboardingStep", step, dismissed }).pipe(
    Effect.map((response) => expectType(response, "onboarding").progress),
  );

/**
 * Whether this machine can run the system's own widget, and how to add it.
 *
 * There is deliberately no "install" call. The macOS widget is placed by the
 * user through the system widget gallery, so the app reports facts and explains
 * the procedure; it cannot install the widget and must not imply that it did.
 */
export const getSystemWidgetStatus = () =>
  request({ type: "systemWidgetStatus" }).pipe(
    Effect.map((response) => expectType(response, "systemWidget").status),
  );