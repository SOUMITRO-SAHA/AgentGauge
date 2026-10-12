/**
 * The Settings About panel: what this build is, and where it lives.
 *
 * The identity row mirrors the sidebar's own brand composition — the one mark
 * the app has, at a larger size, on an ink tile with the version badge beside
 * the name — so the screen opens by saying whose settings these are. The
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
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          data-testid="about-mark"
          className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary"
        >
          <BrandMark className="size-6 text-[var(--brand-teal)]" />
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
    <div
      className="flex items-center gap-3"
      role="status"
      aria-label="Reading the build facts"
    >
      <Skeleton className="size-10 rounded-lg" aria-hidden="true" />
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
