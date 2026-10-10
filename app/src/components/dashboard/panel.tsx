import { ArrowClockwise } from "@phosphor-icons/react";

import { Button } from "~/components/ui/button";

/**
 * The dashboard's panel treatment, shared by every panel.
 *
 * The padding is fluid rather than fixed so the layout holds from the 300px
 * widget window up to a wide desktop window without a separate breakpoint.
 */
/**
 * The shared panel surface.
 *
 * `rounded-lg` rather than `rounded-xl`: with `--radius` at 0.625rem the scale
 * makes `xl` 14px, and macOS cards sit at 10–12px. A panel is the app's
 * largest rounded surface, so it is where an oversized radius reads most
 * obviously as web rather than native.
 */
export const PANEL =
  "rounded-lg border border-border/70 bg-surface-raised/70 p-[clamp(0.75rem,2.5vw,1.25rem)] backdrop-blur-md";

/** A panel with an optional refresh action in its header. */
export function Panel({
  testId,
  children,
}: {
  readonly testId?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className={PANEL} data-testid={testId}>
      {children}
    </section>
  );
}

/**
 * A panel title with a refresh action.
 *
 * The title truncates rather than wrapping, so the action stays on one line at
 * narrow widths instead of pushing itself off-screen.
 */
export function PanelHeader({
  title,
  testId,
  onRefresh,
}: {
  readonly title: string;
  readonly testId: string;
  readonly onRefresh: () => void;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-2">
      <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0"
        onClick={onRefresh}
        data-testid={testId}
      >
        <ArrowClockwise aria-hidden="true" />
        <span className="hidden sm:inline">Refresh</span>
      </Button>
    </div>
  );
}