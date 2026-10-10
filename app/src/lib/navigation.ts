/**
 * The navigation model: which destinations exist, and which layout shows them.
 *
 * Kept free of React and of the DOM so it can be reasoned about and tested on
 * its own. The two things a reader usually has to guess — the set of
 * destinations and the width at which the layout changes — are both here as
 * named constants, and both are pinned by `navigation.test.ts`.
 *
 * ## Icons
 *
 * Every icon in the app is Phosphor (`@phosphor-icons/react`), never a second
 * family. Two icon sets in one product read as a mistake, and Phosphor's
 * `weight` prop is what carries the macOS look: a regular-weight outline when
 * idle, `fill` when a destination is selected.
 */

import type { Icon } from "@phosphor-icons/react";
import {
  ChartBar,
  Gear,
  House,
  Pulse,
} from "@phosphor-icons/react";

/**
 * The destinations, in reading order.
 *
 * `home` is first because it answers "is my window usable right now", which is
 * the question the app exists for. `settings` is last because it is the
 * destination a user reaches for deliberately rather than by browsing.
 */
export interface RouteDefinition {
  readonly id: Route;
  readonly label: string;
  /** One line on what the destination is for, shown under its heading. */
  readonly description: string;
  readonly icon: Icon;
}

/**
 * The width at which the navigation becomes a sidebar.
 *
 * 768px is where a labelled sidebar and the content beside it both still fit
 * without either scrolling. It sits inside the window's own range — 960px wide
 * by default, down to 360px — so both layouts are reachable by resizing, and
 * `navigation.test.ts` fails if that ever stops being true.
 *
 * The media query in `app-shell.tsx` uses the same number, so the layout
 * switches on width rather than on any other signal.
 */
export const NAV_BREAKPOINT_PX = 768;

/** Which navigation layout is showing. */
export type NavLayout = "sidebar" | "tabBar";

/**
 * The layout for a given width.
 *
 * The specification of the breakpoint the shell implements: the shadcn
 * `Sidebar`'s `useIsMobile()` hook flips the navigation at this exact width,
 * and `navigation.test.ts` pins both the rule and the fact that it sits inside
 * the window's own size range.
 */
export function layoutForWidth(width: number): NavLayout {
  return width >= NAV_BREAKPOINT_PX ? "sidebar" : "tabBar";
}

/** A destination. */
export type Route = "home" | "automation" | "stats" | "settings";

/** The destination shown on first paint. */
export const DEFAULT_ROUTE: Route = "home";

export const ROUTES: ReadonlyArray<RouteDefinition> = [
  {
    id: "home",
    label: "Home",
    description: "Whether your window is usable right now.",
    icon: House,
  },
  {
    id: "automation",
    label: "Automation",
    description: "Watching for the moment a window resets.",
    icon: Pulse,
  },
  {
    id: "stats",
    label: "Stats",
    description: "Every window, with what remains in each.",
    icon: ChartBar,
  },
  {
    id: "settings",
    label: "Settings",
    description: "The system widget and this build.",
    icon: Gear,
  },
];

/**
 * Every destination, in order.
 *
 * A function rather than a bare array so the exported list cannot be mutated
 * by a consumer and leave the navigation and the route table disagreeing.
 */
export function routesNeedingNavigation(): ReadonlyArray<RouteDefinition> {
  return ROUTES;
}

/**
 * Narrows an arbitrary value to a {@link Route}.
 *
 * Returns `false` rather than a default: a value that is not a destination is
 * not a reason to show Home, because the user would then have no way to tell
 * the app had lost their selection.
 */
export function isRoute(value: unknown): value is Route {
  return (
    typeof value === "string" &&
    ROUTES.some((route) => route.id === (value as Route))
  );
}

/** The label for a destination, with a safe fallback. */
export function routeLabel(route: Route): string {
  return ROUTES.find((candidate) => candidate.id === route)?.label ?? "Home";
}

/**
 * The shape of a key event the shortcut rule needs.
 *
 * A structural subset of `KeyboardEvent`, so the rule stays testable without a
 * DOM and the listener can pass the event straight through.
 */
export interface ShortcutKeyEvent {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
}

/**
 * The destination a keyboard shortcut selects, or none.
 *
 * ⌘1…⌘4 (control on other keyboards) map to `ROUTES` by position, so the
 * shortcut set is derived from the destination list and cannot claim a
 * destination that does not exist — a fifth route would acquire ⌘5 simply by
 * being added, and never before.
 *
 * Chords with extra modifiers answer `null`: ⌘⇧1 and ⌘⌥1 conventionally mean
 * something else, and stealing them would break the user's other tools. The
 * listener must ignore `null` rather than treat it as Home.
 */
export function routeForShortcut(event: ShortcutKeyEvent): Route | null {
  // Boolean() coerces absent flags, so `{ key: "3" }` — no modifiers at all —
  // is rejected the same as `{ metaKey: false }`.
  if (Boolean(event.metaKey) === Boolean(event.ctrlKey)) {
    return null;
  }
  if (event.altKey || event.shiftKey) {
    return null;
  }

  const index = Number(event.key) - 1;
  return ROUTES[index]?.id ?? null;
}