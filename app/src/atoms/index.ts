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
 * Reads usage for every provider.
 *
 * A provider that fails becomes an `unavailable` snapshot in Rust, so one broken
 * provider never blanks the dashboard.
 */
export const usageAtom = runtime.atom(Ipc.getUsage);

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
