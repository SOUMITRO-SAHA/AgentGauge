import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";

import { systemWidgetAtom } from "~/atoms";
import { PANEL, PanelHeader } from "~/components/dashboard/panel";

import type { SystemWidgetStatus } from "~/lib/ipc";

/**
 * The system's own widget, and how to add it on this machine.
 *
 * ## Why a guide and not a button
 *
 * The previous version of this panel opened a frameless, always-on-top window
 * from inside the app. That is not how macOS widgets work: a widget is an
 * extension the user places through the system gallery, and the system then owns
 * its position, size, and refresh schedule. It also floats over whatever the user
 * is working in, which is exactly the problem this replaces.
 *
 * So the app cannot install the widget and must not imply that it did. There is
 * no "Set up widget" affordance here — only what is true about this build, and
 * the system's own procedure for this macOS release.
 *
 * ## What this cannot tell you
 *
 * macOS exposes no API for asking whether a user has placed an app's widget, so
 * this never claims the widget is on their desktop. `extensionPresent` means the
 * extension is inside this build's bundle — a fact about the build, not a claim
 * about the user's screen.
 */
export function SystemWidgetGuide() {
  const widget = useAtomValue(systemWidgetAtom);
  const refreshWidget = useAtomRefresh(systemWidgetAtom);

  return (
    <section className={PANEL} data-testid="widget-panel">
      <PanelHeader
        title="System widget"
        testId="refresh-widget"
        onRefresh={refreshWidget}
      />

      {AsyncResult.match(widget, {
        onInitial: () => (
          <p className="text-sm text-muted-foreground">
            Checking this Mac for widget support…
          </p>
        ),
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
          Not in this build. Run <code>bun run tauri build</code> and open the
          packaged app — the dev server has no bundle to put the widget in.
        </span>
      </p>
    );
  }

  return (
    <p
      data-testid="widget-status"
      data-state="ready"
      className="flex items-start gap-2 text-sm text-muted-foreground"
    >
      <CheckCircle
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-[var(--ok)]"
      />
      <span>
        {status.snapshotWritten
          ? `Ready to add on macOS ${status.osVersion ?? status.minimumVersion}.`
          : "Ready to add. It will fill in once the app has read a usage window."}
      </span>
    </p>
  );
}