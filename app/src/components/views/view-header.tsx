/**
 * The page header every destination opens with.
 *
 * One component rather than four copies of the same markup: the h1/subtitle
 * rhythm has to be identical on every destination or the shell reads as four
 * screens assembled at different times, which is exactly what hand-repeating a
 * header invites.
 *
 * The title states the destination, not the app. The sidebar already carries
 * the product name — repeating it as Home's heading spent the most prominent
 * line on screen saying something the reader had just read one column to the
 * left.
 */

/** Scales with the window so the heading never dominates a small one. */
const TITLE = "text-[clamp(1.25rem,3.5vw,1.75rem)]";

export function ViewHeader({
  title,
  subtitle,
}: {
  readonly title: string;
  readonly subtitle: string;
}) {
  return (
    <header className="flex flex-col gap-1.5">
      <h1
        className={`${TITLE} font-semibold tracking-tight text-foreground`}
      >
        {title}
      </h1>
      <p className="max-w-prose text-sm text-muted-foreground">{subtitle}</p>
    </header>
  );
}