/**
 * The Settings About panel: what this build is, and where it lives.
 *
 * The version, platform, and every outbound link arrive from the backend's
 * `appInfo`, so the panel states only what the running build reported — no
 * copy in here can drift from the packaged version. A failed read is named
 * (`about-failed`) rather than papered over with invented facts.
 */

import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { appInfoAtom } from "~/atoms";
import { PANEL, PanelHeader } from "~/components/dashboard/panel";
import { OutboundLink } from "~/components/settings/outbound-link";
import { Skeleton } from "~/components/ui/skeleton";

import type { AppInfo } from "~/lib/ipc";

export function AboutPanel() {
  const info = useAtomValue(appInfoAtom);

  return (
    <section className={PANEL} data-testid="about-panel">
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
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">
          AgentGauge{" "}
          <span className="tabular text-muted-foreground" data-testid="about-version">
            {info.appVersion}
          </span>
        </p>
        <p className="text-sm text-muted-foreground" data-testid="about-system">
          {system}
        </p>
      </div>
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

function AboutSkeleton() {
  return (
    <div className="flex flex-col gap-3" role="status" aria-label="Reading the build facts">
      <Skeleton className="h-4 w-32 max-w-full" aria-hidden="true" />
      <Skeleton className="h-3 w-44 max-w-full" aria-hidden="true" />
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
