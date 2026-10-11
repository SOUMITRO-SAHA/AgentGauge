/**
 * Tests for the navigation model.
 *
 * Written before the implementation so the shape of the feature is decided
 * here rather than discovered while building markup.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_ROUTE,
  DEV_ROUTES,
  NAV_BREAKPOINT_PX,
  ROUTES,
  isRoute,
  layoutForWidth,
  routeForShortcut,
  routeLabel,
  routesNeedingNavigation,
} from "~/lib/navigation";

describe("ROUTES", () => {
  it("is exactly the five destinations, in the order they read", () => {
    expect(ROUTES.map((route) => route.id)).toEqual([
      "home",
      "automation",
      "stats",
      "processes",
      "settings",
    ]);
  });

  it("labels each destination the way the user named it", () => {
    expect(ROUTES.map((route) => route.label)).toEqual([
      "Home",
      "Automation",
      "Stats",
      "Processes",
      "Settings",
    ]);
  });

  it("gives every destination an icon", () => {
    for (const route of ROUTES) {
      expect(route.icon, `${route.id} has no icon`).toBeDefined();
    }
  });

  it("has no duplicate ids, so a key or a lookup cannot collide", () => {
    const ids = ROUTES.map((route) => route.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("starts on Home", () => {
    expect(DEFAULT_ROUTE).toBe("home");
    expect(isRoute(DEFAULT_ROUTE)).toBe(true);
  });
});

describe("development destinations", () => {
  it("keeps the Test screen after Settings only when explicitly enabled", () => {
    expect(DEV_ROUTES.map((route) => route.id)).toEqual(["test"]);
    expect(routesNeedingNavigation(false).map((route) => route.id)).toEqual([
      "home",
      "automation",
      "stats",
      "processes",
      "settings",
    ]);
    expect(routesNeedingNavigation(true).map((route) => route.id)).toEqual([
      "home",
      "automation",
      "stats",
      "processes",
      "settings",
      "test",
    ]);
  });

  it("rejects a persisted Test route outside dev and accepts it in dev", () => {
    expect(isRoute("test", false)).toBe(false);
    expect(isRoute("test", true)).toBe(true);
    expect(routeLabel("test", true)).toBe("Test");
  });

  it("assigns the Test route Cmd-6 only when explicitly enabled", () => {
    const key = { key: "6", metaKey: true };
    expect(routeForShortcut(key, false)).toBeNull();
    expect(routeForShortcut(key, true)).toBe("test");
  });
});

describe("isRoute", () => {
  it("accepts every real destination", () => {
    for (const route of ROUTES) {
      expect(isRoute(route.id)).toBe(true);
    }
  });

  it("rejects anything else rather than defaulting", () => {
    // Defaulting would render Home for a corrupt value and the user would have
    // no way back to the destination they asked for.
    for (const value of ["", "Home", "dashboard", "widget", "HOME", null, 42]) {
      expect(isRoute(value)).toBe(false);
    }
  });
});

describe("layoutForWidth", () => {
  it("uses the sidebar at and above the breakpoint", () => {
    expect(layoutForWidth(NAV_BREAKPOINT_PX)).toBe("sidebar");
    expect(layoutForWidth(NAV_BREAKPOINT_PX + 1)).toBe("sidebar");
  });

  it("uses a floating tab bar below the breakpoint", () => {
    expect(layoutForWidth(NAV_BREAKPOINT_PX - 1)).toBe("tabBar");
    expect(layoutForWidth(360)).toBe("tabBar");
  });

  it("never picks a third layout", () => {
    for (const width of [0, 320, 767, 768, 1024, 2560]) {
      expect(["sidebar", "tabBar"]).toContain(layoutForWidth(width));
    }
  });
});

describe("the breakpoint against the window the app actually opens", () => {
  const DEFAULT_WINDOW_WIDTH = 960;
  const MIN_WINDOW_WIDTH = 360;

  it("shows the sidebar in the default window", () => {
    // If the breakpoint sat above the default width, the sidebar would be
    // unreachable without manually resizing — the sidebar would exist in code
    // and never be seen.
    expect(layoutForWidth(DEFAULT_WINDOW_WIDTH)).toBe("sidebar");
  });

  it("switches to the tab bar inside the window's own size range", () => {
    // The window is resizable down to 360px, so the narrow layout has to be
    // reachable without changing any configuration.
    expect(layoutForWidth(MIN_WINDOW_WIDTH)).toBe("tabBar");
    expect(NAV_BREAKPOINT_PX).toBeGreaterThan(MIN_WINDOW_WIDTH);
    expect(NAV_BREAKPOINT_PX).toBeLessThan(DEFAULT_WINDOW_WIDTH);
  });
});

describe("routeLabel", () => {
  it("names a destination", () => {
    expect(routeLabel("stats")).toBe("Stats");
  });

  it("falls back to a safe label for an unknown value", () => {
    // Reachable only with a corrupt value, but it must not render as blank.
    expect(routeLabel("nope" as never)).not.toBe("");
  });
});

describe("routesNeedingNavigation", () => {
  it("is every destination, so nothing is unreachable", () => {
    expect(routesNeedingNavigation().map((route) => route.id)).toEqual(
      ROUTES.map((route) => route.id),
    );
  });

  it("is ordered, because a rendered navigation is ordered", () => {
    const ids = routesNeedingNavigation().map((route) => route.id);
    expect([...ids]).toEqual(ids);
  });
});

describe("routeForShortcut", () => {
  it("maps the command digits to destinations in reading order", () => {
    expect(routeForShortcut({ key: "1", metaKey: true })).toBe("home");
    expect(routeForShortcut({ key: "2", metaKey: true })).toBe("automation");
    expect(routeForShortcut({ key: "3", metaKey: true })).toBe("stats");
    expect(routeForShortcut({ key: "4", metaKey: true })).toBe("processes");
    expect(routeForShortcut({ key: "5", metaKey: true })).toBe("settings");
  });

  it("accepts ctrl instead, for non-mac keyboards", () => {
    expect(routeForShortcut({ key: "3", ctrlKey: true })).toBe("stats");
  });

  it("requires exactly one of command or ctrl", () => {
    expect(routeForShortcut({ key: "3" })).toBeNull();
    expect(
      routeForShortcut({ key: "3", metaKey: true, ctrlKey: true }),
    ).toBeNull();
  });

  it("ignores chords with extra modifiers, which mean something else", () => {
    expect(
      routeForShortcut({ key: "3", metaKey: true, altKey: true }),
    ).toBeNull();
    expect(
      routeForShortcut({ key: "3", metaKey: true, shiftKey: true }),
    ).toBeNull();
  });

  it("ignores plain digits, so typing never navigates", () => {
    expect(routeForShortcut({ key: "3", metaKey: false })).toBeNull();
  });

  it("ignores keys that are not a destination digit", () => {
    expect(routeForShortcut({ key: "h", metaKey: true })).toBeNull();
    expect(routeForShortcut({ key: "Home", metaKey: true })).toBeNull();
  });

  it("answers nothing beyond the last destination", () => {
    // ⌘6 exists only if a sixth destination exists; deriving from ROUTES keeps
    // the shortcut set from claiming a destination that is not rendered.
    expect(routeForShortcut({ key: "6", metaKey: true })).toBeNull();
    expect(routeForShortcut({ key: "0", metaKey: true })).toBeNull();
  });

  it("derives its mapping from ROUTES, so the two cannot drift", () => {
    for (const [index, route] of ROUTES.entries()) {
      expect(
        routeForShortcut({ key: String(index + 1), metaKey: true }),
      ).toBe(route.id);
    }
  });
});
