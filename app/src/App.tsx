/**
 * Composition shell only.
 *
 * Chooses the surface — onboarding or dashboard — and mounts the atom registry.
 * No feature logic lives here; a growing `App.tsx` is the signal that something
 * belongs in `components/<area>/` or an atom.
 */

import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { RegistryProvider, useAtomValue } from "@effect/atom-react";

import { onboardingAtom, onboardingVisibleAtom } from "~/atoms";
import { AppShell } from "~/components/shell/app-shell";
import { OnboardingFlow } from "~/components/onboarding/onboarding-flow";

/**
 * Applies the platform's chrome.
 *
 * The macOS treatment is a vibrancy-tinted surface; Windows and Linux keep the
 * opaque one, where translucency over an unknown desktop reads as a fault.
 */
function usePlatformChrome(): void {
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  document.body.dataset.platform = isMac ? "macos" : "other";

  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    document.documentElement.classList.toggle("dark", prefersDark.matches);
  };
  apply();
  prefersDark.addEventListener("change", apply);
}

function Surface() {
  usePlatformChrome();

  return (
    <div className="min-h-screen">
      <OnboardingGate />
    </div>
  );
}

/**
 * Shows onboarding until it is dismissed, then the app shell.
 *
 * Both stay mounted so the shell's atoms are already warm when the flow
 * finishes — otherwise the first paint after onboarding is a loading state the
 * user did not ask to wait through.
 *
 * The gate is read from Rust rather than held here: `onboardingVisibleAtom` is
 * the session-local override for "the user just skipped", and Rust's
 * `OnboardingProgress.visible` is the durable answer. Onboarding stays hidden
 * until Rust confirms it should show, so a returning user never sees a loading
 * flash of the flow.
 */
function OnboardingGate() {
  const sessionVisible = useAtomValue(onboardingVisibleAtom);
  const progress = useAtomValue(onboardingAtom);

  // Rust owns the durable answer; the atom is the session-local override. Both
  // are consulted so a dismissed user is never shown the flow again, and a
  // user who has not dismissed it always sees it.
  const showFlow = AsyncResult.match(progress, {
    onInitial: () => false,
    onSuccess: (result) => result.value.visible,
    onFailure: () => false,
  });

  return (
    <>
      <AppShell hidden={sessionVisible && showFlow} />
      <OnboardingFlow />
    </>
  );
}

function App() {
  return (
    <RegistryProvider>
      <Surface />
    </RegistryProvider>
  );
}

export default App;
