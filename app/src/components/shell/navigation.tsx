/**
 * The navigation itself.
 *
 * Two presentations of one route table, split on the window width exactly as
 * shadcn's own `Sidebar` splits — `useIsMobile()` at 768px, the same width
 * `NAV_BREAKPOINT_PX` documents and `layoutForWidth` tests:
 *
 *  - **Wide:** the shadcn `Sidebar` — `SidebarProvider`'s theme tokens, a
 *    selection state that comes from `SidebarMenuButton isActive`, tooltips
 *    with each destination's description, and two collapse controls: a trigger
 *    on the brand row, and a hover-revealed expand button just outside the
 *    collapsed pane. Made glassy by a translucent `--sidebar`
 *    token plus a blur, over the window's vibrancy.
 *  - **Narrow:** a floating glass pill at the bottom. shadcn has no bottom
 *    tab-bar component, so this half is small and local — shadcn `Button`s in
 *    a glass container, the same Phosphor icons, the same selection rule.
 *
 * Both render the same testids (`nav`, `nav-<route>`), so specs read either
 * presentation identically.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { CaretRight } from "@phosphor-icons/react";

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
  SidebarTrigger,
  useSidebar,
} from "~/components/ui/sidebar";
import { useIsMobile } from "~/hooks/use-mobile";
import { DEV_TEST_SCREEN_ENABLED } from "~/lib/dev-test-screen";
import { routesNeedingNavigation, type Route } from "~/lib/navigation";
import { cn } from "~/lib/utils";

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

/**
 * The brand mark, inlined.
 *
 * The SVG is part of the React tree rather than an `<img src="/logo.svg">`:
 * the asset carried its own `prefers-color-scheme` fill switch, and WKWebView
 * resolves that query inside image-loaded SVG documents against the light
 * appearance — the app UI followed the system into dark while the mark kept
 * its dark ink and vanished into the sidebar. `fill="currentColor"` under the
 * `text-foreground` token makes the mark follow the app's own theme, which is
 * the one source of truth the webview cannot second-guess. Callers may
 * override the colour through `className`; the fill follows `currentColor`.
 */
export function BrandMark({ className }: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 512 512"
      role="img"
      aria-label="AgentGauge brand mark"
      data-testid="brand-mark"
      className={cn("size-5 shrink-0 fill-current text-foreground", className)}
    >
      <path
        fillRule="evenodd"
        d="M256 64 456 432H344L256 300 168 432H56ZM256 145 322 300H190Z"
      />
      <path d="M181 302h30v40h-30zM241 302h30v40h-30zM301 302h30v40h-30z" />
    </svg>
  );
}

/** Wide windows: the shadcn sidebar. */
function SidebarNav({
  onNavigate,
}: {
  readonly onNavigate: (route: Route) => void;
}) {
  const route = useAtomValue(routeAtom);
  const navigate = useNavigate(onNavigate);
  const { toggleSidebar } = useSidebar();

  return (
    <Sidebar
      // `none` would silently ignore `variant`: the primitive's none-branch
      // returns a bare full-bleed column, so only `icon` renders the
      // floating pane (inset, border, radius, shadow).
      collapsible="icon"
      variant="floating"
      data-testid="nav"
    >
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1">
          <BrandMark />
          <span
            data-testid="brand-name"
            className="font-display text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden"
          >
            AgentGauge
          </span>
          {/* Collapse lives on the brand row, the way the system's own
              panes do; hidden when collapsed, where the mark stands alone
              and the parked control outside the pane takes over. */}
          <SidebarTrigger
            className="ml-auto group-data-[collapsible=icon]:hidden"
            data-testid="sidebar-trigger"
          />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Destinations</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {routesNeedingNavigation(DEV_TEST_SCREEN_ENABLED).map((definition) => {
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

      {/*
        The way back once the pane is collapsed: parked just outside the pane
        on the brand row, revealed only while the sidebar is hovered. The
        8px chain of container padding between the pane's edge and the button
        keeps the hover continuous, so it does not flicker out mid-reach.
      */}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Expand sidebar"
        data-testid="nav-expand"
        onClick={toggleSidebar}
        className="absolute top-4 -right-7 z-20 hidden size-7 text-sidebar-foreground opacity-0 pointer-events-none transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-data-[collapsible=icon]:flex focus-visible:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <CaretRight weight="regular" aria-hidden="true" />
      </Button>
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
      className="glass fixed inset-x-0 bottom-2 z-40 mx-auto flex w-fit max-w-[calc(100vw-1.5rem)] items-stretch gap-0.5 rounded-full p-1.5 shadow-lg"
    >
      {routesNeedingNavigation(DEV_TEST_SCREEN_ENABLED).map((definition) => {
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
