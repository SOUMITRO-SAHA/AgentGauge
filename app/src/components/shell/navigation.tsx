/**
 * The navigation itself.
 *
 * Two presentations of one route table, split on the window width exactly as
 * shadcn's own `Sidebar` splits — `useIsMobile()` at 768px, the same width
 * `NAV_BREAKPOINT_PX` documents and `layoutForWidth` tests:
 *
 *  - **Wide:** the shadcn `Sidebar` — `SidebarProvider`'s theme tokens, a
 *    selection state that comes from `SidebarMenuButton isActive`, tooltips
 *    with each destination's description, and a draggable rail. Made glassy by
 *    a translucent `--sidebar` token plus a blur, over the window's vibrancy.
 *  - **Narrow:** a floating glass pill at the bottom. shadcn has no bottom
 *    tab-bar component, so this half is small and local — shadcn `Button`s in
 *    a glass container, the same Phosphor icons, the same selection rule.
 *
 * Both render the same testids (`nav`, `nav-<route>`), so specs read either
 * presentation identically.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";

import { routeAtom } from "~/atoms";
import { Button } from "~/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "~/components/ui/sidebar";
import { useIsMobile } from "~/hooks/use-mobile";
import { ROUTES, type Route } from "~/lib/navigation";

export function Navigation({
  onNavigate,
}: {
  readonly onNavigate: (route: Route) => void;
}) {
  // `useIsMobile` starts `false` and corrects after mount, so a narrow window
  // paints the sidebar for a frame before the pill takes over. The app is a
  // desktop shell — no server render to stay consistent with — and the e2e
  // settles before asserting, so the one-frame flip is accepted in exchange
  // for reusing the library's own breakpoint instead of a second one.
  const isMobile = useIsMobile();

  return isMobile ? (
    <FloatingTabs onNavigate={onNavigate} />
  ) : (
    <SidebarNav onNavigate={onNavigate} />
  );
}

/** The shared click handler: route atom first, persistence second. */
function useNavigate(onNavigate: (route: Route) => void) {
  const setRoute = useAtomSet(routeAtom);
  return (route: Route) => {
    setRoute(route);
    onNavigate(route);
  };
}

/** Wide windows: the shadcn sidebar. */
function SidebarNav({
  onNavigate,
}: {
  readonly onNavigate: (route: Route) => void;
}) {
  const route = useAtomValue(routeAtom);
  const navigate = useNavigate(onNavigate);

  return (
    <Sidebar
      collapsible="none"
      // `floating` is shadcn's own detached-pane variant: it insets the sidebar
      // from the window edge and gives it its own border, radius and shadow,
      // rather than the full-bleed default. That is the macOS sidebar-pane look
      // and it is a supported prop, not a hand-rolled margin.
      variant="floating"
      data-testid="nav"
      className="backdrop-blur-xl"
    >
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1">
          <img
            src="/agentgauge-mark.svg"
            alt=""
            aria-label="AgentGauge brand mark"
            role="img"
            data-testid="brand-mark"
            className="size-5 rounded-[5px]"
          />
          <span className="text-sm font-semibold tracking-tight">
            AgentGauge
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Destinations</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {ROUTES.map((definition) => {
                const active = route === definition.id;
                const Icon = definition.icon;
                return (
                  <SidebarMenuItem key={definition.id}>
                    <SidebarMenuButton
                      isActive={active}
                      tooltip={definition.description}
                      aria-current={active ? "page" : undefined}
                      data-testid={`nav-${definition.id}`}
                      onClick={() => navigate(definition.id)}
                    >
                      <Icon
                        weight={active ? "fill" : "regular"}
                        aria-hidden="true"
                      />
                      <span>{definition.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* The rail drags the sidebar narrower, the way the system's own do. */}
      <SidebarRail />
    </Sidebar>
  );
}

/** Narrow windows: a floating glass pill of tabs. */
function FloatingTabs({
  onNavigate,
}: {
  readonly onNavigate: (route: Route) => void;
}) {
  const route = useAtomValue(routeAtom);
  const navigate = useNavigate(onNavigate);

  return (
    <nav
      data-testid="nav"
      aria-label="Destinations"
      className="glass fixed inset-x-0 bottom-0 z-40 mx-auto flex w-fit max-w-[calc(100vw-1.5rem)] items-stretch gap-0.5 rounded-full p-1.5 shadow-lg"
    >
      {ROUTES.map((definition) => {
        const active = route === definition.id;
        const Icon = definition.icon;
        return (
          <Button
            key={definition.id}
            variant="ghost"
            size="sm"
            aria-current={active ? "page" : undefined}
            data-testid={`nav-${definition.id}`}
            data-active={active}
            onClick={() => navigate(definition.id)}
            className={[
              "h-auto flex-col gap-0.5 rounded-full px-3 py-2 text-[0.65rem] font-medium",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent"
                : "text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            <Icon
              size={18}
              weight={active ? "fill" : "regular"}
              aria-hidden="true"
            />
            <span>{definition.label}</span>
          </Button>
        );
      })}
    </nav>
  );
}
