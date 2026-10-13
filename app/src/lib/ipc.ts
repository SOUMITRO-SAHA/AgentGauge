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

import * as Cause from "effect/Cause";
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

/**
 * One running process in the read-only process insights.
 *
 * `startedAt` is Unix **seconds**; uptime is derived against the clock so it
 * ticks without another read. `memoryBytes` is the resident set size.
 * `listeningPorts` are the TCP ports the process listens on — empty is a
 * real answer (a stdio server listens on nothing), not a missing reading.
 */
export const ProcessSummary = Schema.Struct({
  pid: Schema.Number,
  name: Schema.String,
  command: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.Number),
  memoryBytes: Schema.NullOr(Schema.Number),
  /** Percent of one core over the read's sampling interval; >100 is several cores. */
  cpuUsage: Schema.NullOr(Schema.Number),
  /** Present only for states a user must know about (`stopped`, `zombie`, `dead`). */
  status: Schema.NullOr(Schema.String),
  listeningPorts: Schema.Array(Schema.Number),
});
export type ProcessSummary = typeof ProcessSummary.Type;

/** One process's listening TCP socket, as the platform scan reported it. */
export const ProcessPort = Schema.Struct({
  pid: Schema.Number,
  port: Schema.Number,
  /** The interface the socket is bound to; `*` means every interface. */
  address: Schema.NullOr(Schema.String),
});
export type ProcessPort = typeof ProcessPort.Type;

/**
 * The running OpenCode background service, as the tool itself recorded it.
 *
 * The registry file also carries the server's password; Rust never reads
 * that field, so it cannot appear here.
 */
export const ServiceInfo = Schema.Struct({
  version: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  pid: Schema.NullOr(Schema.Number),
});
export type ServiceInfo = typeof ServiceInfo.Type;

/**
 * Whether the group's listening ports could be determined, and where they
 * are.
 *
 * `checked` with an empty list is a real answer — the platform was asked and
 * nothing is listening — while `unavailable` carries the reason the question
 * could not be asked (no port-inspection tool on this platform).
 */
export const PortScan = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("checked"),
    listening: Schema.Array(ProcessPort),
  }),
  Schema.Struct({
    state: Schema.Literal("unavailable"),
    reason: Schema.String,
  }),
]);
export type PortScan = typeof PortScan.Type;

/** One labelled piece of a storage footprint. */
export const StorageRow = Schema.Struct({
  label: Schema.String,
  path: Schema.String,
  bytes: Schema.Number,
  fileCount: Schema.Number,
});
export type StorageRow = typeof StorageRow.Type;

/**
 * A group's storage footprint, or the honest reason there is none.
 *
 * `absent` is a real answer — a tool that never created its data directory —
 * and must never render as `0 B`, which would read as measured emptiness.
 */
export const StorageReport = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("measured"),
    totalBytes: Schema.Number,
    totalFiles: Schema.Number,
    rows: Schema.Array(StorageRow),
    /**
     * Footprint the tool relocated outside its data directory
     * (`CODEX_SQLITE_HOME`, `OPENCODE_DB`). Not part of `totalBytes`, which
     * describes the walked root only.
     */
    externalRows: Schema.Array(StorageRow),
  }),
  Schema.Struct({
    state: Schema.Literal("absent"),
    reason: Schema.String,
  }),
]);
export type StorageReport = typeof StorageReport.Type;

/**
 * Everything the Processes screen shows about one group. The groups arrive in
 * display order from Rust; adding a future CLI is a backend addition the
 * renderer renders without a change.
 */
export const ProcessGroup = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  processes: Schema.Array(ProcessSummary),
  totalMemoryBytes: Schema.Number,
  /** The group's summed CPU share, `null` when no member reported a sample. */
  totalCpuUsage: Schema.NullOr(Schema.Number),
  storage: StorageReport,
  ports: PortScan,
  /** The tool's self-recorded background service, only when its pid is live. */
  service: Schema.NullOr(ServiceInfo),
});
export type ProcessGroup = typeof ProcessGroup.Type;

/** The whole process-insights read, stamped at its fetch time. */
export const ProcessInsights = Schema.Struct({
  /** Epoch milliseconds. */
  fetchedAt: Schema.Number,
  groups: Schema.Array(ProcessGroup),
});
export type ProcessInsights = typeof ProcessInsights.Type;

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
  "lite",
  "max",
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

/**
 * One model's share of a provider-reported breakdown.
 *
 * `id` is the normalised catalog slug (the price-list join key); the provider
 * display name rides beside it.
 */
export const ModelUsage = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  tokens: Schema.Number,
  requests: Schema.NullOr(Schema.Number),
});
export type ModelUsage = typeof ModelUsage.Type;

export const ModelDayUsage = Schema.Struct({
  day: Schema.String,
  modelId: Schema.String,
  displayName: Schema.String,
  tokens: Schema.Number,
});
export type ModelDayUsage = typeof ModelDayUsage.Type;

/**
 * The prompt-cache split a provider publishes for its reported window.
 *
 * `hitRate` is the vendor's own rate when it publishes one; otherwise the share
 * is read off `cachedPromptTokens / promptTokens`, which is the arithmetic that
 * rate is built from.
 */
export const CacheStats = Schema.Struct({
  hitRate: Schema.NullOr(Schema.Number),
  promptTokens: Schema.Number,
  cachedPromptTokens: Schema.Number,
});
export type CacheStats = typeof CacheStats.Type;

/**
 * One model's usage as read from the user's own local harness logs.
 *
 * The token split is per-response fact, not a total: `cachedInput` is part of
 * `input`, `reasoning` is part of `output`. `costUsd` is null when the price
 * list cannot cover the model — never 0 for an unpriced model.
 */
export const LocalModelUsage = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  input: Schema.Number,
  cachedInput: Schema.Number,
  cacheWrite: Schema.Number,
  output: Schema.Number,
  reasoning: Schema.Number,
  responses: Schema.Number,
  costUsd: Schema.NullOr(Schema.Number),
});
export type LocalModelUsage = typeof LocalModelUsage.Type;

/**
 * One project's usage, from the working directory its turns ran in.
 *
 * `name` is the directory's basename: an absolute path would put the account
 * name on screen. `costUsd` is null when the price list could not price every
 * model the project used, so the view shows token counts rather than a $0 that
 * reads as free.
 */
export const LocalProjectUsage = Schema.Struct({
  name: Schema.String,
  input: Schema.Number,
  output: Schema.Number,
  responses: Schema.Number,
  costUsd: Schema.NullOr(Schema.Number),
});
export type LocalProjectUsage = typeof LocalProjectUsage.Type;

/** One calendar day of local activity, ISO `YYYY-MM-DD` in UTC. */
export const LocalDayUsage = Schema.Struct({
  day: Schema.String,
  tokens: Schema.Number,
});
export type LocalDayUsage = typeof LocalDayUsage.Type;

export const LocalModelDayUsage = Schema.Struct({
  day: Schema.String,
  id: Schema.String,
  displayName: Schema.String,
  tokens: Schema.Number,
  costUsd: Schema.NullOr(Schema.Number),
});
export type LocalModelDayUsage = typeof LocalModelDayUsage.Type;

export const LocalSessionDayUsage = Schema.Struct({
  day: Schema.String,
  sessions: Schema.Number,
});
export type LocalSessionDayUsage = typeof LocalSessionDayUsage.Type;

/**
 * What the app read from the user's own local logs.
 *
 * Separate from the provider's account totals on purpose: different source,
 * different coverage window, different failure counters. `filesUnreadable`
 * and `filesCompressed` name the logs whose tokens are *not* in these totals,
 * so the view can say what is missing rather than imply completeness.
 */
export const LocalUsage = Schema.Struct({
  models: Schema.Array(LocalModelUsage),
  modelDays: Schema.optional(Schema.Array(LocalModelDayUsage)),
  /** Ranked by tokens. Empty when the source records no working directory. */
  projects: Schema.Array(LocalProjectUsage),
  days: Schema.Array(LocalDayUsage),
  sessionDays: Schema.optional(Schema.Array(LocalSessionDayUsage)),
  medianTokensPerSession: Schema.optional(Schema.NullOr(Schema.Number)),
  compactions: Schema.optional(Schema.NullOr(Schema.Number)),
  /** API-equivalent cost of every priced model. Exact: the logs carry a real
   * per-response split, so no blended average is involved. */
  costUsd: Schema.Number,
  /** Tokens whose model the price list does not cover. */
  unpricedTokens: Schema.Number,
  sessions: Schema.Number,
  filesScanned: Schema.Number,
  filesUnreadable: Schema.Number,
  filesCompressed: Schema.Number,
  firstDay: Schema.NullOr(Schema.String),
  lastDay: Schema.NullOr(Schema.String),
});
export type LocalUsage = typeof LocalUsage.Type;

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
   * The per-model breakdown, when the provider reports one. Empty means the
   * provider totals only — a real answer, not a failed read.
   */
  models: Schema.Array(ModelUsage),
  modelDailyUsage: Schema.optional(Schema.Array(ModelDayUsage)),
  /**
   * The provider's own prompt-cache split. `null` means the provider published
   * none — never a zero hit rate.
   */
  cacheStats: Schema.NullOr(CacheStats),
  /**
   * Local harness data included by providers that combine it with account
   * activity. Codex reads its rollout files through the separate local-usage
   * request so its API result does not wait for that scan.
   */
  local: Schema.NullOr(LocalUsage),
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
  configured: Schema.NullOr(Schema.Boolean),
  placedKinds: Schema.Array(Schema.String),
  menuBarAvailable: Schema.Boolean,
  setup: Schema.Array(
    Schema.Struct({ title: Schema.String, detail: Schema.String }),
  ),
  reason: Schema.NullOr(Schema.String),
});
export type SystemWidgetStatus = typeof SystemWidgetStatus.Type;

export const VolumeAccessStatus = Schema.Struct({
  needsConsent: Schema.Boolean,
  consented: Schema.Boolean,
});
export type VolumeAccessStatus = typeof VolumeAccessStatus.Type;

/**
 * One place a reader can support the project.
 */
export const FundingLink = Schema.Struct({
  label: Schema.String,
  url: Schema.String,
});
export type FundingLink = typeof FundingLink.Type;

/**
 * The outbound destinations this build offers. Every URL arrives from the
 * backend, which owns them and allowlists them on the way back out.
 */
export const AppLinks = Schema.Struct({
  repository: Schema.String,
  releases: Schema.String,
  bugReport: Schema.String,
  featureRequest: Schema.String,
  funding: Schema.Array(FundingLink),
});
export type AppLinks = typeof AppLinks.Type;

/**
 * Facts about this build, for the Settings screen's About panel.
 *
 * `diagnostics` is the same facts as a short Markdown block, prefilled into
 * bug reports and offered for pasting anywhere — build facts only, never
 * usage data or credentials.
 */
export const AppInfo = Schema.Struct({
  appVersion: Schema.String,
  os: Schema.String,
  arch: Schema.String,
  osVersion: Schema.NullOr(Schema.String),
  diagnostics: Schema.String,
  links: AppLinks,
});
export type AppInfo = typeof AppInfo.Type;

export const PingOutcome = Schema.Struct({
  accepted: Schema.Boolean,
  reply: Schema.String,
  usage: Schema.NullOr(UsageSnapshot),
  reason: Schema.NullOr(Schema.String),
});
export type PingOutcome = typeof PingOutcome.Type;

/** One supported effort that the model accepts. */
export const KickoffEffort = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});
export type KickoffEffort = typeof KickoffEffort.Type;

/** One model the scheduled kickoff may use; `cheapest` marks the price-ranked default. */
export const KickoffModel = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  cheapest: Schema.Boolean,
  efforts: Schema.optional(Schema.Array(KickoffEffort)),
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
  effortId: Schema.optional(Schema.String),
  modelError: Schema.optional(Schema.NullOr(Schema.String)),
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
  Schema.Struct({ type: Schema.Literal("appInfo") }),
  Schema.Struct({ type: Schema.Literal("updateChannel") }),
  Schema.Struct({ type: Schema.Literal("upgradeHomebrew"), version: Schema.String }),
  Schema.Struct({ type: Schema.Literal("openLink"), url: Schema.String }),
  Schema.Struct({ type: Schema.Literal("cliDetection") }),
  Schema.Struct({ type: Schema.Literal("processInsights") }),
  Schema.Struct({ type: Schema.Literal("openCodeSubscriptions") }),
  Schema.Struct({ type: Schema.Literal("readUsage") }),
  Schema.Struct({ type: Schema.Literal("readUsageFor"), provider: ProviderKind }),
  Schema.Struct({ type: Schema.Literal("readAccountUsage"), provider: ProviderKind }),
  Schema.Struct({ type: Schema.Literal("readLocalUsage"), provider: ProviderKind }),
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
  Schema.Struct({
    type: Schema.Literal("setKickoffEffort"),
    kind: ProviderKind,
    effortId: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("onboardingProgress") }),
  Schema.Struct({
    type: Schema.Literal("setOnboardingStep"),
    step: OnboardingStep,
    dismissed: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("systemWidgetStatus") }),
  Schema.Struct({ type: Schema.Literal("volumeAccess") }),
  Schema.Struct({ type: Schema.Literal("grantVolumeAccess") }),
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
  Schema.Struct({ type: Schema.Literal("appInfo"), info: AppInfo }),
  Schema.Struct({ type: Schema.Literal("updateChannel"), channel: Schema.Literals(["direct", "homebrew"]) }),
  Schema.Struct({ type: Schema.Literal("homebrewUpgraded") }),
  Schema.Struct({ type: Schema.Literal("linkOpened") }),
  Schema.Struct({
    type: Schema.Literal("cliDetections"),
    tools: Schema.Array(CliToolStatus),
  }),
  Schema.Struct({
    type: Schema.Literal("processInsights"),
    insights: ProcessInsights,
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
  Schema.Struct({ type: Schema.Literal("localUsage"), usage: Schema.NullOr(LocalUsage) }),
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
  Schema.Struct({ type: Schema.Literal("volumeAccess"), status: VolumeAccessStatus }),
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
 * A failed read's own reason, or `null` when it did not carry one.
 *
 * The atom exposes failures as an `AsyncResult` Failure whose cause holds the
 * protocol's `AppError`; the message is this app's or the backend's own
 * wording, so callers present it verbatim rather than inventing a paraphrase.
 */
export function failureReason(cause: Cause.Cause<AppError>): string | null {
  const squashed = Cause.squash(cause);
  return squashed instanceof Error && squashed.message.length > 0
    ? squashed.message
    : null;
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
 * This build's facts, and the outbound links the Settings screen offers.
 *
 * The links are data, not literals in the renderer: the backend owns them and
 * refuses anything else on the way back out.
 */
export const getAppInfo = () =>
  request({ type: "appInfo" }).pipe(
    Effect.map((response) => expectType(response, "appInfo").info),
  );

export const getUpdateChannel = () =>
  request({ type: "updateChannel" }).pipe(
    Effect.map((response) => expectType(response, "updateChannel").channel),
  );

export const upgradeHomebrew = (version: string) =>
  request({ type: "upgradeHomebrew", version }).pipe(
    Effect.map((response) => { expectType(response, "homebrewUpgraded"); }),
  );

/**
 * Opens one of the app's own outbound links in the user's browser.
 *
 * Rust allowlists the URL before the opener runs, so this reaches only the
 * destinations `getAppInfo` named.
 */
export const openLink = (url: string) =>
  request({ type: "openLink", url }).pipe(
    Effect.map((response) => {
      expectType(response, "linkOpened");
    }),
  );

/** Detects supported coding-agent CLIs using only their version commands. */
export const getCliDetection = () =>
  request({ type: "cliDetection" }).pipe(
    Effect.map((response) => expectType(response, "cliDetections").tools),
  );

/**
 * Reads the read-only process and storage insights for the app and the
 * tracked CLIs.
 *
 * There is no counterpart write anywhere in the protocol: the screen cannot
 * stop, signal, or delete anything, by construction.
 */
export const getProcessInsights = () =>
  request({ type: "processInsights" }).pipe(
    Effect.map((response) => expectType(response, "processInsights").insights),
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

/** Reads local harness-log token activity for one provider. */
export const getLocalUsage = (provider: ProviderKind) =>
  request({ type: "readLocalUsage", provider }).pipe(
    Effect.map((response) => expectType(response, "localUsage").usage),
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

/** Selects the effort the scheduled kickoff uses for one subscription. */
export const setKickoffEffort = (kind: ProviderKind, effortId: string) =>
  request({ type: "setKickoffEffort", kind, effortId }).pipe(
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

export const getVolumeAccess = () =>
  request({ type: "volumeAccess" }).pipe(
    Effect.map((response) => expectType(response, "volumeAccess").status),
  );

export const grantVolumeAccess = () =>
  request({ type: "grantVolumeAccess" }).pipe(
    Effect.map((response) => expectType(response, "volumeAccess").status),
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
