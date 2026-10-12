/**
 * The client-side state: every value the app renders comes from an atom here.
 *
 * Components read with `useAtomValue` and write with `useAtomSet`. None of them
 * call `invoke` or keep a `useState` mirror of fetched data — an effectful atom
 * owns its fetch and exposes an `AsyncResult`, so "loading" is a real state
 * rather than a boolean that can disagree with the data.
 *
 * Import paths follow the installed `effect@4.0.0-beta.107`, which exposes the
 * atom modules under `effect/unstable/reactivity/*`.
 */

import * as Atom from "effect/unstable/reactivity/Atom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Ipc from "~/lib/ipc";
import { loadPriceList } from "~/lib/pricing";
import { DEFAULT_ROUTE, type Route } from "~/lib/navigation";

/**
 * The runtime atoms run in.
 *
 * The protocol module is the entire client-side dependency surface — there are
 * no services to inject yet — so this is an empty layer rather than a
 * placeholder for one.
 */
const runtime = Atom.runtime(Layer.empty);

/** Detects installed CLI tools without starting an agent session. */
export const cliDetectionAtom = runtime.atom(Ipc.getCliDetection);

/**
 * The coding subscriptions OpenCode reports, which decide which tabs exist
 * beside Codex on the Home usage panel.
 */
export const subscriptionsAtom = runtime.atom(Ipc.getOpenCodeSubscriptions);

/**
 * Which usage tab is showing — a `ProviderKind` value, or the catalog id of a
 * connected plan this build cannot read.
 */
export const selectedTabAtom = Atom.make("codex");

/**
 * One usage atom per provider, retained for the session.
 *
 * Switching a tab must not wait on a read: the panel renders the provider's
 * last reading immediately while a fresh one runs, and only a provider seen
 * for the first time shows the skeleton. The infinite idle TTL is what holds
 * the reading — the default disposes an atom the moment its tab unmounts,
 * which would turn every revisit into a first visit.
 */
const usageByProvider = new Map<
  Ipc.ProviderKind,
  ReturnType<typeof makeUsageAtom>
>();

function makeUsageAtom(kind: Ipc.ProviderKind) {
  return Atom.setIdleTTL(Infinity)(
    runtime.atom(() => Ipc.getUsageFor(kind)),
  );
}

/** The session-retained usage atom for one provider. */
export function usageForAtom(kind: Ipc.ProviderKind) {
  let atom = usageByProvider.get(kind);
  if (atom === undefined) {
    atom = makeUsageAtom(kind);
    usageByProvider.set(kind, atom);
  }
  return atom;
}

/**
 * One account-analytics atom per provider, retained for the session.
 *
 * The same retention rule as the usage atoms: returning to a stats tab
 * renders the last reading instantly while a fresh one runs underneath. The
 * read runs only while the stats view is showing — a hidden view never reads
 * the account in the background.
 */
const accountUsageByProvider = new Map<
  Ipc.ProviderKind,
  ReturnType<typeof makeAccountUsageAtom>
>();

function makeAccountUsageAtom(kind: Ipc.ProviderKind) {
  return Atom.setIdleTTL(Infinity)(
    runtime.atom(() => Ipc.getAccountUsage(kind)),
  );
}

/** The session-retained account-analytics atom for one provider. */
export function accountUsageForAtom(kind: Ipc.ProviderKind) {
  let atom = accountUsageByProvider.get(kind);
  if (atom === undefined) {
    atom = makeAccountUsageAtom(kind);
    accountUsageByProvider.set(kind, atom);
  }
  return atom;
}

/**
 * The scheduled kickoff state for every connected plan, retained for the
 * session.
 *
 * One atom for the whole overview: the schedule is a single file the worker
 * also writes, so reading it per-provider would be four copies of one truth.
 * Writes go through the command and the section refreshes this atom after.
 */
export const kickoffAtom = Atom.setIdleTTL(Infinity)(
  runtime.atom(() => Ipc.getKickoffState()),
);

/** Finds one subscription's kickoff state inside an overview. */
export function kickoffViewOf(
  overview: Ipc.KickoffOverview,
  kind: Ipc.ProviderKind,
): Ipc.KickoffView | null {
  return overview.subscriptions.find((view) => view.kind === kind) ?? null;
}

/**
 * The read-only process and storage insights, retained for the session.
 *
 * One atom for the whole report: the read is a single snapshot of every
 * group at one instant, so per-group atoms could disagree about when "now"
 * was and split one screen into several truths.
 */
export const processInsightsAtom = Atom.setIdleTTL(Infinity)(
  runtime.atom(() => Ipc.getProcessInsights()),
);

/**
 * The bundled price list, retained for the session.
 *
 * It is a static asset, so one read serves the whole session. A failed load
 * is a real state the model mix renders honestly (token shares without
 * estimates), never a retry loop or an invented price. The loader returns a
 * plain promise, so the atom wraps it in an Effect — the runtime resolves
 * Effects into the AsyncResult the hooks observe, and a bare promise would
 * reach the component unresolved.
 */
export const priceListAtom = Atom.setIdleTTL(Infinity)(
  runtime.atom(() =>
    Effect.tryPromise({
      try: () => loadPriceList(),
      catch: (cause) =>
        new Error(
          cause instanceof Error
            ? cause.message
            : "The price list could not be read.",
        ),
    }),
  ),
);

/**
 * Which tab the Stats view is showing.
 *
 * The overview (`all`) is the landing tab: the question a user brings to a
 * usage screen is which plan they are on and which one is costing them, and
 * answering it should not require knowing which provider runs first.
 */
export const statsTabAtom = Atom.make("all");

/** The Codex account's plan tier. */
export const planAtom = runtime.atom(Ipc.getPlan("codex"));

/** The rollover monitor's state, including any detected rollover. */
export const automationAtom = runtime.atom(Ipc.getAutomationState);

/** Whether this machine can run the system widget, and how to add it. */
export const systemWidgetAtom = runtime.atom(Ipc.getSystemWidgetStatus);

/** This build's facts, and the outbound links the Settings screen offers. */
export const appInfoAtom = runtime.atom(Ipc.getAppInfo);

/** Persisted onboarding progress. */
export const onboardingAtom = runtime.atom(Ipc.getOnboardingProgress);

/**
 * The clock, in epoch milliseconds.
 *
 * A plain value atom rather than an effectful one: a countdown is derived from
 * this during render, so an `AsyncResult` here would render "no clock yet"
 * instead of a time. It is seeded once and advanced by `tickClock`.
 *
 * This is the single injected time source — no component calls `Date.now()`.
 */
export const nowAtom = Atom.make(Date.now());

/**
 * Whether the onboarding flow is showing.
 *
 * Seeded from the persisted state on the first read, then owned by the client
 * for the rest of the session so skipping does not require a round trip. The
 * *rule* for whether it reappears lives in Rust (`OnboardingProgress.visible`);
 * this only tracks the live value.
 */
export const onboardingVisibleAtom = Atom.make<boolean>(true);

/**
 * The destination currently shown, persisted across launches.
 *
 * The value is chosen by using the navigation; the shell mirrors every change
 * into the Rust-side `settings.json` (`setUiState`) and restores it once on
 * mount, clamped through `isRoute` so a stored word from an older build falls
 * back to Home instead of breaking the decode.
 *
 * The narrow/sidebar layout is inferred from the window width in CSS, never
 * from here.
 */
export const routeAtom = Atom.make<Route>(DEFAULT_ROUTE);

export { Atom };
