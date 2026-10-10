/**
 * Settings: the system widget and this build.
 *
 * Deliberately narrow. The only durable preference so far — which destination
 * reopens on launch — is chosen by using the navigation itself, so there is no
 * toggle to render here and none is invented. Everything else the app can say
 * about its own configuration is what the widget guide reports: facts about
 * the build, never a claim that something was installed.
 *
 * Owns the widget testids (`widget-panel`, `widget-status`,
 * `widget-setup-steps`, `refresh-widget`), moved here from the dashboard.
 */

import { SystemWidgetGuide } from "~/components/widget/system-widget-guide";
import { ViewHeader } from "~/components/views/view-header";

export function SettingsView({ visible }: { readonly visible: boolean }) {
  return (
    <div className={visible ? "block" : "hidden"} data-testid="view-settings">
      <ViewHeader title="Settings" subtitle="The system widget and this build." />

      <SystemWidgetGuide />

      {/* Footnote, not loose text: the guide above is a panel, and this needs
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
