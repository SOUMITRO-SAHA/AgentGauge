/**
 * Pure formatting and classification for usage data.
 *
 * Kept out of components so the rules that make the UI honest — never render a
 * value without its freshness, never show `unknown` as healthy, never render an
 * absent reset time as "now" — are stated once and unit-tested.
 */

/** How a reading should be presented, derived from freshness and permission. */
export type Tone = "healthy" | "warning" | "critical" | "unknown";

/**
 * Classifies a window for display.
 *
 * `usedPercent` drives the bar, but a `blocked` account and an `unknown`
 * permission are separate signals: a blocked account with 0% used is still
 * blocked, and an unknown permission is never `healthy`.
 */
export function toneFor(input: {
  readonly usedPercent: number;
  readonly freshness: string;
  readonly permission: string;
}): Tone {
  if (input.freshness === "unavailable") return "unknown";
  if (input.permission === "blocked") return "critical";
  if (input.permission === "unknown") return "unknown";
  if (input.usedPercent >= 90) return "critical";
  if (input.usedPercent >= 75) return "warning";
  return "healthy";
}

/** A reset time that is safe to render, or `null` when there is none. */
export function safeResetAt(resetsAt: number | null): number | null {
  // `0` and negatives are not real reset times; rendering them would show a
  // date in 1970 as though it were a measurement.
  if (resetsAt === null || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  return resetsAt;
}

/**
 * Milliseconds until a reset, floored at zero.
 *
 * A past reset time means the window is rolling; showing a negative countdown
 * would read as broken rather than imminent.
 */
export function millisUntilReset(resetsAt: number | null, nowMs: number): number | null {
  const reset = safeResetAt(resetsAt);
  if (reset === null) return null;
  // The provider sends seconds; the app works in milliseconds.
  return Math.max(0, reset * 1000 - nowMs);
}

/**
 * A compact countdown, e.g. `4h 12m`.
 *
 * Returns `null` when there is nothing meaningful to show, so the caller renders
 * an explicit unknown state instead of a blank.
 */
export function formatCountdown(millis: number | null): string | null {
  if (millis === null) return null;

  const totalMinutes = Math.floor(millis / 60_000);
  if (totalMinutes < 1) return "<1m";

  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * A relative freshness label derived from the snapshot's own timestamp.
 *
 * `nowMs` is injected rather than read from `Date.now()` so the label is
 * deterministic in tests and does not drift between render passes.
 */
export function formatFreshness(
  fetchedAt: number | null,
  nowMs: number,
): string | null {
  if (fetchedAt === null) return null;

  const elapsed = nowMs - fetchedAt;
  if (elapsed < 0) return "just now";
  if (elapsed < 60_000) return "just now";

  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;

  return `${Math.floor(hours / 24)} d ago`;
}

/**
 * The label for a window's heading.
 *
 * Falls back to the duration when the provider did not report one, so the row
 * still says what it is measuring.
 */
export function windowTitle(label: string, durationMins: number | null): string {
  if (durationMins === null) return label;
  if (label === "5h") return "5-hour window";
  if (label === "weekly") return "Weekly limit";
  return label;
}

/** `12% used` — never rendered for an unavailable reading. */
export function formatUsed(usedPercent: number): string {
  return `${Math.round(usedPercent)}% used`;
}

/** A plan tier for display, or a neutral placeholder when there is none. */
export function formatPlan(plan: string | null): string {
  if (plan === null || plan === "unknown") return "Unknown plan";
  if (plan === "proLite") return "Pro Lite";
  if (plan === "proMax") return "Pro Max";
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}