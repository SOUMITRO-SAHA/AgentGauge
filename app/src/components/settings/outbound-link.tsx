/**
 * A button that opens one of the app's own outbound links.
 *
 * The URL is always a value from the backend's `appInfo` — Rust refuses
 * anything its allowlist does not name before the system opener runs, so this
 * component can only reach destinations the build itself vouches for. A
 * refusal surfaces as panel text rather than a silent no-op. The variant is
 * the caller's: most links are quiet outlines, a call to action is filled.
 */

import { useState } from "react";
import * as Effect from "effect/Effect";
import { ArrowSquareOut } from "@phosphor-icons/react";

import { Button } from "~/components/ui/button";
import * as Ipc from "~/lib/ipc";

export function OutboundLink({
  url,
  testId,
  variant = "outline",
  size = "sm",
  children,
}: {
  readonly url: string;
  readonly testId: string;
  readonly variant?: React.ComponentProps<typeof Button>["variant"];
  readonly size?: React.ComponentProps<typeof Button>["size"];
  readonly children: React.ReactNode;
}) {
  const [failed, setFailed] = useState(false);

  const open = () => {
    setFailed(false);
    void Effect.runPromise(Ipc.openLink(url)).catch(() => setFailed(true));
  };

  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        variant={variant}
        size={size}
        onClick={open}
        data-testid={testId}
      >
        {children}
        <ArrowSquareOut aria-hidden="true" className="size-3.5" />
      </Button>
      {failed && (
        <span role="alert" className="text-xs text-destructive">
          The link could not be opened.
        </span>
      )}
    </span>
  );
}
