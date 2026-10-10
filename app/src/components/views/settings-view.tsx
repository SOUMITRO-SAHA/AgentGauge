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

export function SettingsView({ visible }: { readonly visible: boolean }) {
  return (
    <div className={visible ? "block" : "hidden"} data-testid="view-settings">
      <header className="flex flex-col gap-1">
        <h1 className="text-[clamp(1.25rem,4vw,1.5rem)] font-semibold tracking-tight text-foreground">
          Settings
        </h1>
        <p className="text-sm text-muted-foreground">
          The system widget and this build.
        </p>
      </header>

      <SystemWidgetGuide />

      <p className="text-xs text-muted-foreground" data-testid="settings-about">
        The destination you reopen on is the one you left — chosen by using the
        navigation, remembered between launches.
      </p>
    </div>
  );
}
