/**
 * Settings: this build, the system widget, and reaching the project.
 *
 * Four panels, each answering one question. About states what this build is —
 * version, platform, and its outbound links, all read from the backend so the
 * renderer cannot drift from the packaged binary. The widget guide explains
 * the system's own widget. Feedback opens the project's issue forms with the
 * build facts prefilled, and Support lists where the project accepts
 * contributions.
 *
 * The only durable preference so far — which destination reopens on launch —
 * is chosen by using the navigation itself, so there is no toggle to render
 * here and none is invented.
 *
 * Owns the widget testids (`widget-panel`, `widget-status`,
 * `widget-setup-steps`, `refresh-widget`), moved here from the dashboard.
 */

import { AboutPanel } from "~/components/settings/about-panel";
import { FeedbackPanel } from "~/components/settings/feedback-panel";
import { SupportPanel } from "~/components/settings/support-panel";
import { SystemWidgetGuide } from "~/components/widget/system-widget-guide";
import { ViewHeader } from "~/components/views/view-header";

export function SettingsView({ visible }: { readonly visible: boolean }) {
  return (
    <div className={visible ? "flex flex-col gap-4" : "hidden"} data-testid="view-settings">
      <ViewHeader
        title="Settings"
        subtitle="This build, the widget, and reaching the project."
      />

      <AboutPanel />

      <SystemWidgetGuide />

      <FeedbackPanel />

      <SupportPanel />

      {/* Footnote, not loose text: the panels above are cards, and this needs
          the same visual separation or it reads as an orphaned sentence. */}
      <p
        className="border-t border-border/60 pt-4 text-xs text-muted-foreground"
        data-testid="settings-about"
      >
        The destination you reopen on is the one you left — chosen by using the
        navigation, remembered between launches.
      </p>
    </div>
  );
}
