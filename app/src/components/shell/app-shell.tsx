/**
 * The application shell: navigation plus the active view.
 *
 * Three decisions live here.
 *
 * 1. **All views stay mounted.** Inactive ones are `display: none`, not
 *    unmounted, so their atoms are warm the instant a destination is chosen —
 *    the same rule the onboarding gate applies to the dashboard. Each view owns
 *    disjoint `data-testid`s precisely because they coexist.
 * 2. **The route is persisted.** A choice survives a relaunch: the shell reads
 *    the stored preference once on mount and writes on every navigation. The
 *    read is guarded — a value that is not a destination is ignored, and a read
 *    that lands after the user has already navigated never overrides them.
 * 3. **⌘1…⌘5 switch production destinations.** Dev builds append the Test
 *    screen as ⌘6; `routeForShortcut` is tested in `navigation.test.ts`.
 */

import * as Effect from "effect/Effect";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useRef } from "react";

import { routeAtom } from "~/atoms";
import { AutomationView } from "~/components/views/automation-view";
import { HomeView } from "~/components/views/home-view";
import { ProcessView } from "~/components/views/process-view";
import { SettingsView } from "~/components/views/settings-view";
import { StatsView } from "~/components/views/stats-view";
import { TestView } from "~/components/views/test-view";
import { Navigation } from "~/components/shell/navigation";
import {
  SidebarInset,
  SidebarProvider,
} from "~/components/ui/sidebar";
import * as Ipc from "~/lib/ipc";
import { DEV_TEST_SCREEN_ENABLED } from "~/lib/dev-test-screen";
import { isRoute, routeForShortcut, type Route } from "~/lib/navigation";

/**
 * The content column.
 *
 * `mx-auto` with a `max-w-*` is the part that matters at wide widths: a fluid
 * full-width column stretches every panel to the window, which at 1280px gives
 * ~1500px-long line lengths and strands the content against the left edge of a
 * very wide window. The cap keeps the reading measure comfortable and centres
 * the column in whatever space the sidebar leaves.
 *
 * `pb-28` clears the floating tab bar on narrow windows, where it sits over the
 * content; at `md` and up the sidebar owns the left edge and the pill is gone.
 */
const PAGE =
  "mx-auto flex w-full max-w-5xl flex-col gap-[clamp(0.75rem,2.5vw,1.5rem)] px-[clamp(0.75rem,4vw,2rem)] py-[clamp(1rem,4vw,2rem)] pb-28 md:pb-10";

export function AppShell({ hidden = false }: { readonly hidden?: boolean }) {
  const route = useAtomValue(routeAtom);
  const setRoute = useAtomSet(routeAtom);
  // Set the moment the user navigates this session, so the mount-time read of
  // the stored preference can never outrun them and yank the view back.
  const navigatedRef = useRef(false);

  const navigate = useCallback(
    (next: Route) => {
      navigatedRef.current = true;
      setRoute(next);
      // The write is reported, not swallowed: a preference lost silently is a
      // preference that lies about having been kept.
      void Effect.runPromise(Ipc.setUiState({ lastRoute: next })).catch(
        (error) => {
          console.error("AgentGauge: could not persist the last destination", error);
        },
      );
    },
    [setRoute],
  );

  useEffect(() => {
    void Effect.runPromise(Ipc.getUiState())
      .then((state) => {
        // A stored value from an older build whose route set differed must
        // fall back to Home, not break the shell.
        if (
          !navigatedRef.current &&
          isRoute(state.lastRoute, DEV_TEST_SCREEN_ENABLED)
        ) {
          setRoute(state.lastRoute);
        }
      })
      .catch(() => {
        // Restoring is best-effort; the shell stays on Home.
      });
  }, [setRoute]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = routeForShortcut(event, DEV_TEST_SCREEN_ENABLED);
      if (target !== null) {
        event.preventDefault();
        navigate(target);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  // Stays mounted while onboarding is showing, atoms warm, exactly as the
  // dashboard did. `display` rather than the `hidden` attribute, so a spec
  // asserting on a child reads the visible node.
  return (
    <div
      className={hidden ? "hidden" : "block"}
      data-testid="app-shell"
      aria-hidden={hidden}
    >
      <SidebarProvider>
        <Navigation onNavigate={navigate} />
        {/* Transparent: the body gradient must be the one backdrop for the
            whole window, or the inset's flat token meets it in a seam. */}
        <SidebarInset className="bg-transparent">
          <div className={PAGE}>
            <HomeView visible={route === "home"} />
            <AutomationView visible={route === "automation"} />
            <StatsView visible={route === "stats"} />
            <ProcessView visible={route === "processes"} />
            <SettingsView visible={route === "settings"} />
            {DEV_TEST_SCREEN_ENABLED && (
              <TestView
                visible={route === "test"}
                onNavigate={navigate}
              />
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}
