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
 * The usage for whichever tab is showing.
 *
 * Reads the selection, so a tab switch re-runs this atom and fetches that one
 * provider. A tab with no reader never fetches; its panel renders the honest
 * "cannot read this yet" state instead.
 */
export const selectedUsageAtom = runtime.atom((get) => {
  const tab = get(selectedTabAtom);
  return Ipc.isProviderKind(tab)
    ? Ipc.getUsageFor(tab)
    : Effect.succeed<readonly Ipc.UsageSnapshot[]>([]);
});

/** Codex account activity; callers must gate reads behind explicit consent. */
export const accountUsageAtom = runtime.atom(Ipc.getAccountUsage);

/** Hydrated from persisted UI preferences before the user enters the stats view. */
export const analyticsConsentAtom = Atom.make(false);

/** The Codex account's plan tier. */
export const planAtom = runtime.atom(Ipc.getPlan("codex"));

/** The rollover monitor's state, including any detected rollover. */
export const automationAtom = runtime.atom(Ipc.getAutomationState);

/** Whether this machine can run the system widget, and how to add it. */
export const systemWidgetAtom = runtime.atom(Ipc.getSystemWidgetStatus);

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
