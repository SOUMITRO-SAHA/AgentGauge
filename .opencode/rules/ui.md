# UI Rules (React, Tailwind, shadcn)

Applies to `app/src/**/*.tsx`, `app/src/components/**`, `app/src/index.css`,
and `app/components.json`. Language-level TypeScript rules are in
[`typescript.md`](typescript.md).

This is the fastest-growing surface in the project, so the conventions are
strict: the app is a **status and usage dashboard**, not a marketing page.

## Stack facts (do not re-litigate)

- React 19 + TypeScript, `react-jsx` transform — **no `import React` needed**
  for JSX. `import * as React from "react"` is correct only when a React
  namespace type or `React.useState` style reference is actually used (shadcn
  primitives rely on this; app components should not).
- Tailwind CSS 4 via `@tailwindcss/vite`. **No `tailwind.config.js`** — theme
  lives in `src/index.css` under `@theme inline`. Do not add a Tailwind 3
  config or `@tailwind base/components/utilities` directives.
- `tw-animate-css` provides the animation utilities (`animate-in`,
  `fade-in-…`) that Tailwind 3 got from `tailwindcss-animate`. Keep the
  `@import` order in `index.css`: tailwind first, then the animation package.
- shadcn/ui: `new-york` style, `neutral` base colour, `lucide` icons, CSS
  variables enabled, `radix-ui` as the unified primitive package.
- Icons come from `lucide-react`. Never hand-roll an SVG icon or inline a
  third-party icon set.

## Adding a component

```sh
cd app
bunx shadcn@latest add card
```

- Add components **with the shadcn CLI**; do not hand-write `ui/*` primitives
  or hand-copy them between projects. The generated code is the source of truth
  for the primitive's contract.
- `app/src/components/ui/` is vendored upstream code: match its existing
  formatting, imports and comment density exactly, and re-generate rather than
  hand-patch when upstream moves. Only apply local changes that are genuinely
  project-specific, and note why in the commit.
- App-level components live in `app/src/components/<area>/` grouped by feature
  or screen, never loose in `components/`. Feature folders match provider or
  domain concepts (`providers/`, `usage/`, `status/`), not file names.
- `~/` alias for all client imports (`~/components/ui/button`, `~/lib/utils`).

## `cn()` — one import, and it is `~/lib/utils`

`cn` is `clsx` + `tailwind-merge` in `app/src/lib/utils.ts`; `components.json`
points its `utils` alias there. **Import `cn` from `~/lib/utils`** and nothing
else.

> Known drift: the generated `app/src/components/ui/button.tsx` currently
> imports the standalone `cn` npm package instead. Do not propagate that
> pattern into app code or newly generated components. If you touch that file,
> align it to `~/lib/utils`.

`twMerge` resolves conflicting Tailwind utilities, so **last-one-wins is the
real precedence**: do not fight it with `!important`, and do not spread a
className in two places that both set the same property.

## Component conventions

- Components are `function` declarations with `PascalCase` exports in
  kebab-case files (`usage-card.tsx` → `UsageCard`). One component per file
  unless they are trivially co-located variants.
- Props: `interface XProps` (not `type XProps = {...}`) for anything with more
  than three members; `React.FC` is not used — declare the return type.
  Interactive elements need `React.ComponentProps<"button">` spread so
  `disabled`, `onClick`, `aria-*` and `ref` keep working.
- Prefer composition over boolean prop explosions. Three or more booleans in a
  signature is a design smell; use a discriminated `variant`/`size` union
  (the `cva` pattern the shadcn primitives already use).
- **`useState` is for ephemeral UI state only** — an open/closed flag, a draft
  input value. Fetched or derived state lives in an atom
  ([`effect.md`](effect.md)). A component that mirrors an atom's value into
  `useState` is a bug.
- Components must not call `invoke` and must not contain async fetching logic.
  They read atoms and render; the atom owns the effect.
- Keys must be stable domain identifiers, never array indices, for anything
  reorderable or refreshable (usage rows, provider lists).
- Keep list rendering explicit. `.map()` with an immediately returned element
  and a key — no inline data transformation buried in JSX; put it in a derived
  value or a `useMemo` when it is not trivial.
- No barrel `index.ts` re-exports for app components — import the file
  directly so the module graph stays legible and the bundle stays tree-shakeable.

## Data display (this app's actual job)

Usage and status data is the product, and it arrives through Effect atoms. Two
independent layers of state must both be handled; conflating them is the most
common defect here.

**Async state — `AsyncResult`, exhaustive matching:**

```ts
const result = useAtomValue(usageAtom)

return AsyncResult.match(result, {
  onInitial: () => <UsageSkeleton />,
  onSuccess: (s) => <UsageCard snapshot={s.value} refreshing={s.waiting} />,
  onFailure: (f) => <UsageUnavailable cause={f.cause} />
})
```

- **Every component handles all three branches.** Ignoring `onFailure` is a bug.
- `Success` with `waiting: true` means a refresh is in flight — render it as
  *stale, refreshing*, never as a fresh reading.
- Never wrap an `AsyncResult` in your own `isLoading` boolean; read the tag.
- Never call `useAtomSuspense` without an error boundary — it throws on
  `Failure` unless `includeFailure` is set.
- A `Cause` is not a string: use `Cause.pretty` / `Cause.squash` to render one
  safely. Never interpolate a raw cause into user-facing text.

**Domain state — the four states, as data:**

- **Never render a value without its freshness.** Any number, status, or limit
  carries its source and last-updated time, or is visibly marked unavailable.
- Model the four states explicitly — `live`, `cached`, `stale`, `unavailable` —
  as a typed union (see [`typescript.md`](typescript.md)), never as a nullable
  number with a truthiness check. A missing value is a **rendered state**, not
  an empty string, `0`, `-`, or a silent `?? 0` fallback that reads like data.
- Distinguish "no usage recorded" from "0% used" from "could not fetch".
  Use the neutral/muted token for unknown, `destructive` for an actual error
  state, and never colour alone to convey state — pair it with text or an icon
  for accessibility.
- Format through the design tokens (`text-muted-foreground`, `bg-muted`,
  `border-border`, `text-destructive`) rather than raw Tailwind palette colours,
  so light and dark both work and future theming stays possible.
- Relative time ("3 min ago") needs a stable clock; compute it from the atom's
  injected timestamp rather than `Date.now()` inside render.

## Accessibility & motion

- Every interactive element is reachable by keyboard and has a visible
  focus ring (the primitives already ship `focus-visible:ring-*` — keep it).
- Status and trend indicators need a text or `aria-label` equivalent; a
  colour or a bare icon fails for screen-reader and colour-blind users.
- Respect `prefers-reduced-motion` before adding any non-essential animation.
  Refresh polling must not steal focus or reorder rows under the cursor.
- Semantic elements first (`button`, `a`, `nav`, `main`); `role`/`tabIndex` are a
  last resort, never a substitute for the right element.

## Styling rules

- Utility classes in JSX; no CSS files, no CSS-in-JS library, no inline
  `style` objects except for genuinely dynamic values (a measured bar width)
  that cannot be expressed as a utility.
- No hardcoded colours (`#38CD65`, `red-500`) — tokens only. If a needed
  semantic token does not exist, add it to `@theme inline` and `:root`/`.dark`
  in `src/index.css` rather than reaching for a palette colour.
- Responsive by default: this app ships to desktop *and* a compact widget
  surface, so every view must hold up at narrow widths.
- No `@apply` in components; only in `index.css` base layer where it already
  lives.