/**
 * Settings: this build, the system widget, and reaching the project.
 *
 * The screen reads as one composition rather than four cards in a pile: the
 * two short panels — About (identity) and Feedback (utility) — pair in a
 * two-up row that sets the rhythm, the widget guide holds the middle as the
 * full-width core a visitor came for, and the Support accent closes the screen
 * with the one call to action. Each panel answers one question; About states
 * what this build is from the backend's `appInfo` so the renderer cannot drift
 * from the packaged binary, the widget guide explains the system's own widget,
 * Feedback opens the project's issue forms with build facts prefilled, and
 * Support lists where the project accepts contributions.
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

      <div
        className="grid items-start gap-4 md:grid-cols-2"
        data-testid="settings-info-row"
      >
        <AboutPanel />
        <FeedbackPanel />
      </div>

      <SystemWidgetGuide />

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
