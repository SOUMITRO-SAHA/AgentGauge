/**
 * The Settings Feedback panel: report a bug, request a feature, or copy the
 * diagnostics anywhere else.
 *
 * The two actions open GitHub's new-issue form with the build facts already
 * filled in, in the browser — nothing is sent anywhere by this app itself,
 * and the user edits the issue before it exists. Copying carries the same
 * block, so the path works even where the form does not (the repository is
 * reached only once it is public).
 */

import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { Bug, Check, Copy, Lightbulb } from "@phosphor-icons/react";

import { appInfoAtom } from "~/atoms";
import { PANEL, PanelHeader } from "~/components/dashboard/panel";
import { OutboundLink } from "~/components/settings/outbound-link";
import { Button } from "~/components/ui/button";

export function FeedbackPanel() {
  const info = useAtomValue(appInfoAtom);
  const [copied, setCopied] = useState(false);

  const copy = (diagnostics: string) => {
    setCopied(false);
    void navigator.clipboard.writeText(diagnostics).then(() => setCopied(true));
  };

  return (
    <section className={PANEL} data-testid="feedback-panel">
      <PanelHeader title="Feedback" />
      {AsyncResult.match(info, {
        onInitial: () => null,
        onFailure: () => null,
        onSuccess: (result) => {
          const { links, diagnostics } = result.value;
          return (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Opens GitHub with your system details filled in — edit before
                submitting. Diagnostics carry build facts only.
              </p>
              <div className="flex flex-wrap items-start gap-2">
                <OutboundLink url={links.bugReport} testId="feedback-bug">
                  <Bug aria-hidden="true" className="size-3.5" />
                  Report a bug
                </OutboundLink>
                <OutboundLink url={links.featureRequest} testId="feedback-feature">
                  <Lightbulb aria-hidden="true" className="size-3.5" />
                  Request a feature
                </OutboundLink>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => copy(diagnostics)}
                  data-testid="feedback-copy"
                >
                  {copied ? (
                    <Check aria-hidden="true" className="size-3.5 text-[var(--ok)]" />
                  ) : (
                    <Copy aria-hidden="true" className="size-3.5" />
                  )}
                  {copied ? "Copied" : "Copy diagnostics"}
                </Button>
              </div>
            </div>
          );
        },
      })}
    </section>
  );
}
