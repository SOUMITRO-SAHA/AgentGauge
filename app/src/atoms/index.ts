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

/**
 * The runtime atoms run in.
 *
 * The protocol module is the entire client-side dependency surface — there are
 * no services to inject yet — so this is an empty layer rather than a
 * placeholder for one.
 */
const runtime = Atom.runtime(Layer.empty);

/** Probes every provider without starting a long-lived process. */
export const providerStatusAtom = runtime.atom(Ipc.getProviderStatus);

/**
 * Reads usage for every provider.
 *
 * A provider that fails becomes an `unavailable` snapshot in Rust, so one broken
 * provider never blanks the dashboard.
 */
export const usageAtom = runtime.atom(Ipc.getUsage);

/** The Codex account's plan tier. */
export const planAtom = runtime.atom(Ipc.getPlan("codex"));

/** The automation watcher's state, including any detected rollover. */
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

export { Atom };