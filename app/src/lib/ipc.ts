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

export const PROVIDER_KINDS = ["codex", "zai", "minimax", "kimi"] as const;
export const ProviderKind = Schema.Literals([...PROVIDER_KINDS]);
export type ProviderKind = typeof ProviderKind.Type;

/**
 * Whether a tab value selects a provider this build can read.
 *
 * A connected plan with no reader uses its catalog id as the tab value, so
 * this guard is what keeps a fetch from being attempted for it.
 */
export function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value);
}

/**
 * Where a subscription's credential reached the machine, as OpenCode reports
 * it. The credential itself never crosses this boundary.
 */
export const CredentialOrigin = Schema.Literals([
  "stored",
  "environment",
  "unknown",
]);
export type CredentialOrigin = typeof CredentialOrigin.Type;

/**
 * A coding subscription the user connected through OpenCode.
 *
 * `integration` is absent when this build cannot read that plan's usage; the
 * tab for it must say so rather than render an invented number.
 */
export const CodingSubscription = Schema.Struct({
  providerId: Schema.String,
  name: Schema.String,
  label: Schema.String,
  integration: Schema.NullOr(ProviderKind),
  credential: CredentialOrigin,
  apiBase: Schema.NullOr(Schema.String),
});
export type CodingSubscription = typeof CodingSubscription.Type;

export const CliToolStatus = Schema.Struct({
  tool: Schema.Literals(["codex", "openCode"]),
  displayName: Schema.String,
  executable: Schema.String,
  installed: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
});
export type CliToolStatus = typeof CliToolStatus.Type;

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

export const AccountUsage = Schema.Struct({
  fetchedAt: Schema.Number,
  summary: Schema.Struct({
    totalTokens: Schema.NullOr(Schema.Number),
    peakDailyTokens: Schema.NullOr(Schema.Number),
    longestRunningTurnSec: Schema.NullOr(Schema.Number),
    currentStreakDays: Schema.NullOr(Schema.Number),
    longestStreakDays: Schema.NullOr(Schema.Number),
    totalRequests: Schema.NullOr(Schema.Number),
  }),
  dailyUsageBuckets: Schema.Array(
    Schema.Struct({
      startDate: Schema.String,
      tokens: Schema.NullOr(Schema.Number),
    }),
  ),
  /**
   * Days the reported window covers, when the provider reports a bounded span
   * rather than the account's lifetime. `null` means lifetime, so the cards
   * may say "lifetime"; a present value must be shown, because a window total
   * must never pose as lifetime.
   */
  windowDays: Schema.NullOr(Schema.Number),
});
export type AccountUsage = typeof AccountUsage.Type;

export const ProviderStatus = Schema.Struct({
  kind: ProviderKind,
  executable: Schema.String,
  installed: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
});
export type ProviderStatus = typeof ProviderStatus.Type;

/**
 * One sub's rollover-monitor state. `kind` is on the wire so the renderer can
 * place each monitor on its sub's card without assuming an order.
 */
export const AutomationState = Schema.Struct({
  kind: ProviderKind,
  running: Schema.Boolean,
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
 * The renderer's persisted preferences, mirroring the Rust `UiState`.
 *
 * The route is typed loosely here and clamped through `isRoute` from
 * `~/lib/navigation` where it is read: the file may hold a value from an older
 * build whose route set differed, and a stale word must fall back to Home, not
 * break the decode and take the whole shell down with it.
 */
export const UiState = Schema.Struct({
  lastRoute: Schema.NullOr(Schema.String),
});
export type UiState = typeof UiState.Type;

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

/** One model the scheduled kickoff may use; `cheapest` is the default. */
export const KickoffModel = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  cheapest: Schema.Boolean,
});
export type KickoffModel = typeof KickoffModel.Type;

/** One subscription's scheduled-kickoff state, shaped for the picker. */
export const KickoffView = Schema.Struct({
  kind: ProviderKind,
  enabled: Schema.Boolean,
  /** The user's selection, if any — distinct from what would be sent. */
  modelId: Schema.NullOr(Schema.String),
  /** The model the next kickoff would actually use. */
  effectiveModel: Schema.String,
  models: Schema.Array(KickoffModel),
  /** Epoch ms of the next scheduled attempt, if one is armed. */
  nextKickAt: Schema.NullOr(Schema.Number),
  lastKickAt: Schema.NullOr(Schema.Number),
  lastAccepted: Schema.NullOr(Schema.Boolean),
  lastDetail: Schema.NullOr(Schema.String),
});
export type KickoffView = typeof KickoffView.Type;

/**
 * Whether the system scheduler can run, and whether it is installed.
 *
 * `supported: false` means the platform has no scheduler integration yet;
 * nothing schedules in the background there, and the UI must say so.
 */
export const SchedulerStatus = Schema.Struct({
  supported: Schema.Boolean,
  installed: Schema.Boolean,
});
export type SchedulerStatus = typeof SchedulerStatus.Type;

export const KickoffOverview = Schema.Struct({
  subscriptions: Schema.Array(KickoffView),
  scheduler: SchedulerStatus,
});
export type KickoffOverview = typeof KickoffOverview.Type;

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
  Schema.Struct({ type: Schema.Literal("cliDetection") }),
  Schema.Struct({ type: Schema.Literal("openCodeSubscriptions") }),
  Schema.Struct({ type: Schema.Literal("readUsage") }),
  Schema.Struct({ type: Schema.Literal("readUsageFor"), provider: ProviderKind }),
  Schema.Struct({ type: Schema.Literal("readAccountUsage"), provider: ProviderKind }),
  Schema.Struct({ type: Schema.Literal("readPlan"), provider: ProviderKind }),
  Schema.Struct({
    type: Schema.Literal("sendPing"),
    prompt: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("automationState") }),
  Schema.Struct({
    type: Schema.Literal("startAutomation"),
    kind: ProviderKind,
  }),
  Schema.Struct({
    type: Schema.Literal("stopAutomation"),
    kind: ProviderKind,
  }),
  Schema.Struct({
    type: Schema.Literal("acknowledgeRollover"),
    kind: ProviderKind,
  }),
  Schema.Struct({ type: Schema.Literal("kickoffState") }),
  Schema.Struct({
    type: Schema.Literal("setKickoffEnabled"),
    kind: ProviderKind,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("setKickoffModel"),
    kind: ProviderKind,
    modelId: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("onboardingProgress") }),
  Schema.Struct({
    type: Schema.Literal("setOnboardingStep"),
    step: OnboardingStep,
    dismissed: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("systemWidgetStatus") }),
  Schema.Struct({ type: Schema.Literal("uiState") }),
  Schema.Struct({
    type: Schema.Literal("setUiState"),
    lastRoute: Schema.NullOr(Schema.String),
  }),
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
    type: Schema.Literal("cliDetections"),
    tools: Schema.Array(CliToolStatus),
  }),
  Schema.Struct({
    type: Schema.Literal("openCodeSubscriptions"),
    subscriptions: Schema.Array(CodingSubscription),
  }),
  Schema.Struct({
    type: Schema.Literal("usage"),
    snapshots: Schema.Array(UsageSnapshot),
  }),
  Schema.Struct({ type: Schema.Literal("accountUsage"), usage: AccountUsage }),
  Schema.Struct({ type: Schema.Literal("plan"), plan: Schema.NullOr(PlanKind) }),
  Schema.Struct({ type: Schema.Literal("ping"), outcome: PingOutcome }),
  Schema.Struct({
    type: Schema.Literal("automation"),
    monitors: Schema.Array(AutomationState),
  }),
  Schema.Struct({
    type: Schema.Literal("kickoff"),
    state: KickoffOverview,
  }),
  Schema.Struct({
    type: Schema.Literal("onboarding"),
    progress: OnboardingProgress,
  }),
  Schema.Struct({ type: Schema.Literal("systemWidget"), status: SystemWidgetStatus }),
  Schema.Struct({
    type: Schema.Literal("uiState"),
    state: UiState,
  }),
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

/** Detects supported coding-agent CLIs using only their version commands. */
export const getCliDetection = () =>
  request({ type: "cliDetection" }).pipe(
    Effect.map((response) => expectType(response, "cliDetections").tools),
  );

/**
 * Lists the coding subscriptions the user connected through OpenCode.
 *
 * An empty list is a real answer — OpenCode absent, or nothing connected —
 * not an error, so the Codex tab stays usable either way.
 */
export const getOpenCodeSubscriptions = () =>
  request({ type: "openCodeSubscriptions" }).pipe(
    Effect.map(
      (response) => expectType(response, "openCodeSubscriptions").subscriptions,
    ),
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

/** Reads an account's token activity for one provider, local analytics permitting. */
export const getAccountUsage = (provider: ProviderKind) =>
  request({ type: "readAccountUsage", provider }).pipe(
    Effect.map((response) => expectType(response, "accountUsage").usage),
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

/** Every sub's rollover-monitor state, one entry per known sub. */
export const getAutomationState = () =>
  request({ type: "automationState" }).pipe(
    Effect.map((response) => expectType(response, "automation").monitors),
  );

/**
 * Starts one sub's rollover monitor.
 *
 * Idempotent, so a double call cannot double-poll — and persisted, so the
 * choice survives a relaunch: the monitor is running again before the first
 * frame renders.
 */
export const startAutomation = (kind: ProviderKind) =>
  request({ type: "startAutomation", kind }).pipe(
    Effect.map((response) => expectType(response, "automation").monitors),
  );

/** Stops one sub's rollover monitor. Persisted like the start. */
export const stopAutomation = (kind: ProviderKind) =>
  request({ type: "stopAutomation", kind }).pipe(
    Effect.map((response) => expectType(response, "automation").monitors),
  );

/** Clears one sub's detected rollover once the UI has shown it. */
export const acknowledgeRollover = (kind: ProviderKind) =>
  request({ type: "acknowledgeRollover", kind }).pipe(
    Effect.map((response) => expectType(response, "automation").monitors),
  );

/** Reads every subscription's scheduled-kickoff state. */
export const getKickoffState = () =>
  request({ type: "kickoffState" }).pipe(
    Effect.map((response) => expectType(response, "kickoff").state),
  );

/**
 * Opts one subscription into (or out of) the scheduled kickoff.
 *
 * This is the explicit quota-spending opt-in: a `true` here is the only thing
 * that may ever arm a timer that sends prompts. Installing the system
 * scheduler is the Rust side's job, and a failure to install is reported.
 */
export const setKickoffEnabled = (kind: ProviderKind, enabled: boolean) =>
  request({ type: "setKickoffEnabled", kind, enabled }).pipe(
    Effect.map((response) => expectType(response, "kickoff").state),
  );

/** Selects the model the scheduled kickoff sends for one subscription. */
export const setKickoffModel = (kind: ProviderKind, modelId: string) =>
  request({ type: "setKickoffModel", kind, modelId }).pipe(
    Effect.map((response) => expectType(response, "kickoff").state),
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

/** Reads the renderer's persisted preferences. */
export const getUiState = () =>
  request({ type: "uiState" }).pipe(
    Effect.map((response) => expectType(response, "uiState").state),
  );

/**
 * Persists the renderer's preferences, so a choice survives a relaunch.
 *
 * A failure is reported rather than swallowed, the same rule as onboarding
 * progress: silently losing a preference is a preference that lies about
 * having been kept.
 */
export const setUiState = (state: Pick<UiState, "lastRoute">) =>
  request({ type: "setUiState", lastRoute: state.lastRoute }).pipe(
    Effect.map((response) => expectType(response, "uiState").state),
  );
