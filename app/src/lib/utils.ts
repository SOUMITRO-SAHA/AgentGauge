// `cn` is the current shadcn class-name merge engine (a drop-in replacement
// for `twMerge(clsx(...))`). Re-exporting it here keeps the single import path
// declared by `components.json` (`aliases.utils`) for project code, while
// components may also import it straight from the package.
//
// Once no code references `clsx` / `tailwind-merge` directly, those two
// packages can be dropped in favour of `cn` alone.
export { cn } from "cn";
