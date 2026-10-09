/**
 * The injected clock.
 *
 * Countdowns and freshness labels are derived from this rather than from
 * `Date.now()` in a component, so they are deterministic under test and cannot
 * drift between render passes.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { nowAtom } from "~/atoms";

/** How often the clock advances. */
const TICK_MS = 30_000;

/**
 * Current time in epoch milliseconds, refreshed on an interval.
 *
 * Kept as a hook so no component reaches for the global clock directly; a
 * component that wants a time takes it from here.
 */
export function useClock(): number {
  const nowMs = useAtomValue(nowAtom);
  const setNow = useAtomSet(nowAtom);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [setNow]);

  return nowMs;
}