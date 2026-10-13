import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import { systemWidgetAtom, widgetSetupRequestedAtom } from "~/atoms";
import { PANEL, PanelHeader } from "~/components/dashboard/panel";
import { Skeleton } from "~/components/ui/skeleton";

import type { SystemWidgetStatus } from "~/lib/ipc";

/**
 * The system's own widget, and how to add it on this machine.
 *
 * ## Placement stays with macOS
 *
 * The previous version of this panel opened a frameless, always-on-top window
 * from inside the app. That is not how macOS widgets work: a widget is an
 * extension the user places through the system gallery, and the system then owns
 * its position, size, and refresh schedule. It also floats over whatever the user
 * is working in, which is exactly the problem this replaces.
 *
 * The sidebar's setup action navigates here and highlights these steps. The app
 * cannot add the widget or open the gallery on the user's behalf.
 *
 * ## What this cannot tell you
 *
 * WidgetCenter reports configured widget kinds, but not their exact location.
 * `extensionPresent` remains a separate fact about this build, and a failed
 * system query remains unknown rather than meaning the widget is absent.
 *
 * ## Keeping the answer current
 *
 * Placement happens in the system's gallery, where the app cannot follow it.
 * `useSystemWidgetStatusPolling` re-reads the status on an interval while the
 * app is open, on focus, and when the window returns from hidden, so both adding
 * and removing a widget is reflected without a manual refresh. An unknown state
 * never hides the guide: the steps below it are the only route to a placement,
 * and an app that could not check must not also remove the way to fix it.
 *
 * A widget placed by the *other* build counts too, from the receipts the
 * extensions write — WidgetCenter's own query cannot see a sibling app.
 */
export function SystemWidgetGuide() {
  const widget = useAtomValue(systemWidgetAtom);
  const refreshWidget = useAtomRefresh(systemWidgetAtom);
  const setupRequested = useAtomValue(widgetSetupRequestedAtom);
  const setSetupRequested = useAtomSet(widgetSetupRequestedAtom);
  const guideRef = useRef<HTMLElement | null>(null);
  const requestConsumed = useRef(false);
  const [highlighted, setHighlighted] = useState(false);

  useEffect(() => {
    if (!setupRequested) {
      requestConsumed.current = false;
      return;
    }
    if (requestConsumed.current) return;

    requestConsumed.current = true;
    guideRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    guideRef.current?.focus({ preventScroll: true });
    setHighlighted(true);
    setSetupRequested(false);
  }, [setupRequested, setSetupRequested]);

  useEffect(() => {
    if (!highlighted) return;
    const timeout = window.setTimeout(() => setHighlighted(false), 2500);
    return () => window.clearTimeout(timeout);
  }, [highlighted]);

  return (
    <section
      ref={guideRef}
      tabIndex={-1}
      data-testid="widget-panel"
      data-highlighted={highlighted}
      className={`${PANEL} transition-colors duration-300 ${highlighted ? "ring-2 ring-brand-teal" : ""}`}
    >
      <PanelHeader
        title="System widget"
        testId="refresh-widget"
        onRefresh={refreshWidget}
      />

      {AsyncResult.match(widget, {
        onInitial: () => <WidgetGuideSkeleton />,
        onFailure: () => (
          <p className="text-sm text-destructive">
            The app could not be reached.
          </p>
        ),
        onSuccess: (result) => <Steps status={result.value} />,
      })}
    </section>
  );
}

function WidgetGuideSkeleton() {
  return (
    <div
      className="flex flex-col gap-4"
      data-testid="widget-loading-skeleton"
      role="status"
      aria-label="Checking system widget support"
    >
      <div className="flex items-start gap-3">
        <Skeleton className="mt-0.5 size-4 rounded-full" aria-hidden="true" />
        <Skeleton className="h-4 w-3/4" aria-hidden="true" />
      </div>
      <div className="flex flex-col gap-3 border-t border-border/60 pt-4">
        <div className="flex items-start gap-3">
          <Skeleton className="mt-0.5 size-5 rounded-full" aria-hidden="true" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-40 max-w-full" aria-hidden="true" />
            <Skeleton className="h-3 w-full max-w-lg" aria-hidden="true" />
          </div>
        </div>
        <div className="flex items-start gap-3">
          <Skeleton className="mt-0.5 size-5 rounded-full" aria-hidden="true" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-32 max-w-full" aria-hidden="true" />
            <Skeleton className="h-3 w-4/5" aria-hidden="true" />
          </div>
        </div>
        <div className="flex items-start gap-3">
          <Skeleton className="mt-0.5 size-5 rounded-full" aria-hidden="true" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-36 max-w-full" aria-hidden="true" />
            <Skeleton className="h-3 w-2/3" aria-hidden="true" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Steps({ status }: { status: SystemWidgetStatus }) {
  return (
    <div className="flex flex-col gap-3">
      <StatusLine status={status} />

      {status.setup.length > 0 && (
        <ol
          data-testid="widget-setup-steps"
          className="flex list-decimal flex-col gap-3 pl-5"
        >
          {status.setup.map((step) => (
            <li key={step.title} className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{step.title}</span>
              <span className="text-sm text-muted-foreground">{step.detail}</span>
            </li>
          ))}
        </ol>
      )}

      {/* Both windows are named up front: a widget that showed only one of them
          would not answer the question the user adds it to ask. */}
      {status.extensionPresent && (
        <p className="text-sm text-muted-foreground">
          Shows your 5-hour window and weekly limit.
        </p>
      )}
    </div>
  );
}

function configuredKindLabel(kind: string): string {
  if (kind === "AIStatsUsageWidgetDev") return "AgentGauge Dev";
  if (kind === "AIStatsUsageWidget") return "AgentGauge";
  return kind;
}

/** Names the widgets the app can see on this Mac, whichever build placed them. */
function placedWidgetLabel(kinds: readonly string[]): string {
  if (kinds.length === 1) {
    return `The ${configuredKindLabel(kinds[0])} widget`;
  }
  return "AgentGauge widgets";
}

function StatusLine({ status }: { status: SystemWidgetStatus }) {
  if (!status.supported) {
    return (
      <p
        data-testid="widget-status"
        data-state="unsupported"
        className="flex items-start gap-2 text-sm text-muted-foreground"
      >
        <WarningCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>{status.reason ?? "Not available on this system."}</span>
      </p>
    );
  }

  if (!status.extensionPresent) {
    return (
      <p
        data-testid="widget-status"
        data-state="not-embedded"
        className="flex items-start gap-2 text-sm text-muted-foreground"
      >
        <WarningCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>
          This running app has no widget extension, so it cannot check whether
          one is configured. That is what <code>bun run tauri dev</code> does —
          it runs a bare binary with no bundle. Run{" "}
          <code>bun run build:mac</code> and open the packaged{" "}
          <code>AgentGauge.app</code>; it embeds the widget and can detect it.
        </span>
      </p>
    );
  }

  if (status.configured === true) {
    return (
      <p
        data-testid="widget-status"
        data-state="configured"
        className="flex items-start gap-2 text-sm text-muted-foreground"
      >
        <CheckCircle
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-[var(--ok)]"
        />
        <span>AgentGauge is configured as a system widget on this Mac.</span>
      </p>
    );
  }

  if (status.placedKinds.length > 0) {
    return (
      <p
        data-testid="widget-status"
        data-state="configured-other-build"
        className="flex items-start gap-2 text-sm text-muted-foreground"
      >
        <CheckCircle
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-[var(--ok)]"
        />
        <span>
          {placedWidgetLabel(status.placedKinds)} is on this Mac
          {status.configured === null
            ? ". Whether this app's own widget is placed could not be checked, and the steps below add it."
            : ", but this app's own widget is not. The steps below add it."}
        </span>
      </p>
    );
  }

  if (status.configured === null) {
    return (
      <p
        data-testid="widget-status"
        data-state="unknown"
        className="flex items-start gap-2 text-sm text-muted-foreground"
      >
        <WarningCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>
          The app could not check whether AgentGauge is configured, so it will
          not claim either way. It re-checks automatically while this window is
          open and whenever it comes back to the front; Refresh checks now.
        </span>
      </p>
    );
  }

  return (
    <p
      data-testid="widget-status"
      data-state="not-configured"
      className="flex items-start gap-2 text-sm text-muted-foreground"
    >
      <WarningCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        AgentGauge is not configured as a system widget. Use the steps below to
        add it.
      </span>
    </p>
  );
}
