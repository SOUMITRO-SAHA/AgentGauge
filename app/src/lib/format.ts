/**
 * Display formatters shared by more than one screen.
 *
 * Each formatter takes a plain number and returns a short, locale-free
 * string: readouts stay stable across renders and comparable in tests, and
 * the exact grouping lives with the numbers that need it, not here.
 */

const SIZE_UNITS = ["B", "kB", "MB", "GB", "TB"] as const;

/**
 * A size in decimal (1000-based) units, the way macOS itself reports sizes.
 *
 * One decimal below 100 of a unit so readouts stay compact but
 * distinguishable (`1.5 kB`); a whole number once the unit carries it
 * (`432 MB`).
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) {
    return `${bytes} B`;
  }

  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < SIZE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }

  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${SIZE_UNITS[unit]}`;
}
