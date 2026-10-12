/**
 * The Settings Support panel: where the project accepts contributions.
 *
 * The destinations come from the backend, which reads the same list the
 * repository's `FUNDING.yml` publishes, so the panel and the repo button can
 * never disagree. One line of context, then the links — supporting is an
 * offer, never a gate on the app itself.
 */

import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { appInfoAtom } from "~/atoms";
import { PANEL, PanelHeader } from "~/components/dashboard/panel";
import { OutboundLink } from "~/components/settings/outbound-link";

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function SupportPanel() {
  const info = useAtomValue(appInfoAtom);

  return (
    <section className={PANEL} data-testid="support-panel">
      <PanelHeader title="Support AgentGauge" />
      {AsyncResult.match(info, {
        onInitial: () => null,
        onFailure: () => null,
        onSuccess: (result) => (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              AgentGauge is free to use. If it saves you time, supporting its
              development helps it keep going:
            </p>
            <div className="flex flex-wrap gap-2">
              {result.value.links.funding.map((link) => (
                <OutboundLink
                  key={link.url}
                  url={link.url}
                  testId={`support-link-${slug(link.label)}`}
                >
                  {link.label}
                </OutboundLink>
              ))}
            </div>
          </div>
        ),
      })}
    </section>
  );
}
