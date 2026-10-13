/**
 * The Settings About panel: what this build is, and where it lives.
 *
 * The identity row uses the sidebar's monochrome brand mark at a larger size,
 * with the version badge beside the name. The
 * version, platform, and every outbound link arrive from the backend's
 * `appInfo`, so the panel states only what the running build reported — no
 * copy in here can drift from the packaged version. A failed read is named
 * (`about-failed`) rather than papered over with invented facts.
 */

import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { appInfoAtom } from "~/atoms";
import { PANEL, PanelHeader } from "~/components/dashboard/panel";
import { OutboundLink } from "~/components/settings/outbound-link";
import { BrandMark } from "~/components/shell/navigation";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { useAppUpdate } from "~/components/updates/app-update-provider";

import type { AppInfo } from "~/lib/ipc";

export function AboutPanel() {
  const info = useAtomValue(appInfoAtom);

  return (
    <section className={`${PANEL} flex flex-col`} data-testid="about-panel">
      <PanelHeader title="About" />
      {AsyncResult.match(info, {
        onInitial: () => <AboutSkeleton />,
        onFailure: () => (
          <p className="text-sm text-destructive" data-testid="about-failed">
            The app could not be reached.
          </p>
        ),
        onSuccess: (result) => <Facts info={result.value} />,
      })}
    </section>
  );
}

function Facts({ info }: { readonly info: AppInfo }) {
  const system = [
    info.osVersion ? `${osLabel(info.os)} ${info.osVersion}` : osLabel(info.os),
    info.arch,
  ].join(" · ");

  return (
    <div className="flex flex-1 flex-col justify-between gap-4">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          data-testid="about-mark"
          className="flex size-10 shrink-0 items-center justify-center"
        >
          <BrandMark className="size-8" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-display text-base font-semibold tracking-tight text-foreground">
              AgentGauge
            </span>
            <Badge
              variant="secondary"
              className="tabular"
              data-testid="about-version"
            >
              v{info.appVersion}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground" data-testid="about-system">
            {system}
          </p>
        </div>
      </div>
      {info.os === "macos" && <UpdateControls />}
      <div className="flex flex-wrap gap-2 border-t border-border/60 pt-3">
        <OutboundLink url={info.links.repository} testId="about-link-repository">
          Repository
        </OutboundLink>
        <OutboundLink url={info.links.releases} testId="about-link-releases">
          Releases
        </OutboundLink>
      </div>
    </div>
  );
}

function UpdateControls() {
  const { state, checkForUpdates, restart, installWithHomebrew } = useAppUpdate();
  const isReady = state.kind === "ready" || state.kind === "restart-failed";
  const isRestarting = state.kind === "restarting";
  const isHomebrew = state.kind === "brew-available" || state.kind === "brew-upgrading" || state.kind === "brew-failed";

  return (
    <div className="flex flex-col gap-2" data-testid="update-controls">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={state.kind === "checking" || isReady || isRestarting || isHomebrew}
        onClick={checkForUpdates}
        data-testid="update-check"
      >
        {state.kind === "checking" ? "Checking…" : "Check for updates"}
      </Button>
      {state.kind === "up-to-date" && (
        <p className="text-xs text-muted-foreground" data-testid="update-up-to-date">
          You’re up to date.
        </p>
      )}
      {state.kind === "failed" && (
        <p className="text-xs text-destructive" data-testid="update-check-failed">
          Could not check for updates. Try again later.
        </p>
      )}
      {isHomebrew && (
        <div className="flex flex-wrap items-center gap-2" data-testid="update-brew-inline">
          <p className="text-xs text-muted-foreground">
            Version {state.update.version} is available through Homebrew.
          </p>
          <Button type="button" size="sm" disabled={state.kind === "brew-upgrading"} onClick={installWithHomebrew} data-testid="update-brew-inline-install">
            {state.kind === "brew-upgrading" ? "Updating…" : "Update with Homebrew"}
          </Button>
          {state.kind === "brew-failed" && <p className="text-xs text-destructive" data-testid="update-brew-inline-failed">Homebrew update failed. Try again or use Terminal.</p>}
        </div>
      )}
      {isReady && (
        <div className="flex flex-wrap items-center gap-2">
          <p
            className="text-xs text-muted-foreground"
            data-testid="update-ready-inline"
          >
            Version {state.update.version} is ready to restart.
          </p>
          <Button
            type="button"
            size="sm"
            onClick={restart}
            data-testid="update-restart-inline"
          >
            Restart now
          </Button>
        </div>
      )}
      {isRestarting && (
        <p className="text-xs text-muted-foreground" data-testid="update-restarting">
          Restarting AgentGauge…
        </p>
      )}
    </div>
  );
}

function AboutSkeleton() {
  return (
    <div
      className="flex items-center gap-3"
      role="status"
      aria-label="Reading the build facts"
    >
      <span className="flex size-10 shrink-0 items-center justify-center">
        <Skeleton className="size-8 rounded-md" aria-hidden="true" />
      </span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-36 max-w-full" aria-hidden="true" />
        <Skeleton className="h-3 w-44 max-w-full" aria-hidden="true" />
      </div>
    </div>
  );
}

function osLabel(os: string): string {
  switch (os) {
    case "macos":
      return "macOS";
    case "windows":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return os;
  }
}
