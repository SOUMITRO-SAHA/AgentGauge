/**
 * The Settings Support panel: where the project accepts contributions.
 *
 * The destinations come from the backend, which reads the same list the
 * repository's `FUNDING.yml` publishes, so the panel and the repo button can
 * never disagree. This is the one panel on the screen allowed an accent
 * treatment — a brand border and a filled primary action — because supporting
 * is an offer the screen should make easy to see, never a gate on the app:
 * the copy states the minimum, the first destination carries the emphasis,
 * and every other link stays a quiet outline.
 */

import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { Heart, PatreonLogo } from "@phosphor-icons/react";

import { appInfoAtom } from "~/atoms";
import { PanelHeader } from "~/components/dashboard/panel";
import { OutboundLink } from "~/components/settings/outbound-link";

/**
 * The panel's accent surface: the shared panel geometry (radius, fluid
 * padding, blur) with the brand border and glass tint that set it apart from
 * every content panel above it.
 */
const SUPPORT_PANEL =
  "rounded-lg border border-[var(--brand-teal)]/40 bg-[var(--accent-glass)] p-[clamp(0.75rem,2.5vw,1.25rem)] backdrop-blur-md";

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function SupportPanel() {
  const info = useAtomValue(appInfoAtom);

  return (
    <section className={SUPPORT_PANEL} data-testid="support-panel">
      <PanelHeader title="Support AgentGauge" />
      {AsyncResult.match(info, {
        onInitial: () => null,
        onFailure: () => null,
        onSuccess: (result) => {
          const [primary, ...rest] = result.value.links.funding;
          return (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-[var(--brand-teal)]/40 text-[var(--brand-teal)]"
                >
                  <Heart weight="fill" className="size-4" />
                </span>
                <p
                  className="max-w-prose text-sm text-muted-foreground"
                  data-testid="support-message"
                >
                  AgentGauge is free to use. If it saves you time, support its
                  development — sponsorships start at just{" "}
                  <span className="font-semibold text-foreground">$1</span>,
                  and every one keeps the roadmap moving.
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {primary && (
                  <OutboundLink
                    url={primary.url}
                    variant="default"
                    size="default"
                    testId={`support-link-${slug(primary.label)}`}
                  >
                    <Heart weight="fill" aria-hidden="true" className="size-3.5" />
                    Sponsor from $1
                  </OutboundLink>
                )}
                {rest.map((link) => (
                  <OutboundLink
                    key={link.url}
                    url={link.url}
                    testId={`support-link-${slug(link.label)}`}
                  >
                    {link.label === "Patreon" && (
                      <PatreonLogo aria-hidden="true" className="size-3.5" />
                    )}
                    {link.label}
                  </OutboundLink>
                ))}
              </div>
            </div>
          );
        },
      })}
    </section>
  );
}
