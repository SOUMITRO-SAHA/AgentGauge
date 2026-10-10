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
- shadcn/ui: `new-york` style, `neutral` base colour, CSS variables enabled,
  `radix-ui` as the unified primitive package. **App icons are Phosphor**
  (`@phosphor-icons/react`), not lucide — the CLI still generates `lucide`
  imports inside some vendored primitives; swap them after every regen that
  touches those files (see "shadcn-first"). Keep `iconLibrary: "lucide"` in
  `components.json`; it is what the CLI consumes, not what app code imports.
- Never hand-roll an SVG icon or inline a third-party icon set.

## shadcn-first — strict

**If shadcn has the component, you use shadcn's. There is no house
alternative.** The `@shadcn` registry ships every primitive this app needs
(button, card, dialog, sheet, dropdown-menu, tooltip, progress, skeleton,
switch, tabs, table, scroll-area, separator, badge, sonner, …). Reaching for a
hand-rolled equivalent — or writing a new component from scratch before
checking the registry — is a defect, not a shortcut.

The research loop, before any UI work:

1. **Search the registry first** — the shadcn MCP tools
   (`search_items_in_registries`, then `get_item_examples_from_registries`
   for a real usage example), or `bunx shadcn@latest view @shadcn` / the docs
   site. Confirm the primitive does not exist before writing one.
2. **Prefer composing primitives over writing components.** A card + badge +
   separator covers most app UI; only escalate to a custom component when a
   composition genuinely cannot express the behaviour.
3. **Install with the CLI**, never by hand:

   ```sh
   cd app
   bunx shadcn@latest add <component>
   ```

4. **Custom components are the exception, and must be justified.** If the
   registry lacks the primitive and no composition works, the new component
   goes in `app/src/components/<area>/`, is built **on top of** vendored
   primitives and theme tokens (never around them), and its reason for
   existing is stated in the PR. A custom component that reimplements a
   registry item will be deleted.

- The generated code is the source of truth for the primitive's contract;
  `app/src/components/ui/` is vendored upstream code: match its existing
  formatting, imports and comment density exactly, and re-generate rather than
  hand-patch when upstream moves. Only apply local changes that are genuinely
  project-specific (the Phosphor swap is the known one), and note why in the
  commit.
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

## Theme, spacing, radius, gloss — strict

The look is **shadcn glossy macOS**: translucent layered surfaces, a soft
specular top edge, and the native 10px corner radius. Every rule below exists
because the alternative reads as a web page inside a Mac window.

### The theme is `src/index.css` — one source of truth

- The current standard theme is the token set in `app/src/index.css`
  (`@theme inline` + `:root`/`.dark`). Use it; **never** redefine colours,
  radii, or shadows inside a component.
- Colours come from semantic tokens only: the shadcn set (`background`,
  `card`, `muted`, `destructive`, …), the brand set (`brand-ink`, `brand-teal`,
  `brand-amber`), the **status tones** (`ok`, `warn`, `critical`, `unknown` —
  never `text-green-500` for healthy), and the **surfaces** (`surface`,
  `surface-raised`, `surface-sunken`, `accent-glass`). No raw Tailwind palette
  colours, no hex literals.
- If a needed semantic token does not exist, add it to `@theme inline` and
  `:root`/`.dark` in `index.css` — both modes, before using it.

### Spacing — the 4px grid

- Spacing utilities come from the Tailwind scale, which is the 4px grid
  (`gap-2` = 8px, `p-4` = 16px, …). No arbitrary values (`p-[13px]`,
  `gap-[7px]`) — off-grid spacing is what makes a layout read as amateur.
- **The one sanctioned arbitrary value is the fluid panel padding**
  `p-[clamp(0.75rem,2.5vw,1.25rem)]`. It already exists as the `PANEL`
  constant in `dashboard/panel.tsx` — reuse that constant (or its exact value)
  instead of inventing a second fluid padding.
- Structural rhythm, keep it consistent: panels and cards stack content with
  `gap-4` (sections) / `gap-2` (related rows); a panel header sits `mb-4`
  above its body, matching `PanelHeader`. Vertical whitespace between major
  panels is the grid container's job (`gap-6`), not per-panel margins.
- Icons inside buttons/text are `size-4` (inline) or `size-5` (nav/header);
  don't resize per call site when the default works.

### Border radius — macOS standard, from `--radius`

The scale derives from a single base, `--radius: 0.625rem` (10px), the macOS
native corner radius. It is already wired in `index.css`; the derived steps
are sm 6px · md 8px · **lg 10px** · xl 14px · 2xl 18px.

Fixed mapping — do not deviate per call site:

| Surface | Radius | Why |
| --- | --- | --- |
| Controls (buttons, inputs, menu items, chips, inline code) | `rounded-md` (8px) | What the vendored primitives already emit; smaller than the surface it sits on |
| Panels, cards, the app's largest content surfaces | `rounded-lg` (10px) | macOS cards sit at 10–12px; `xl` (14px) is where a panel starts reading as web, not native |
| Floating overlays — sheets, popovers, the sidebar inset | `rounded-xl` (14px) | They float above the window chrome, matching macOS popover geometry |
| Progress tracks, avatars, badge dots | inherit the primitive | Regenerate, don't retune |

- Never use `rounded-full` to "finish" a card, never an arbitrary
  `rounded-[Npx]` in app code, and never change `--radius` for one screen —
  the whole point is that every corner in the app sits on the same native
  curve.

### Gloss — the house material

- **`glass` is the glossy material** for navigation/chrome surfaces. It layers
  a translucent fill over the window's vibrancy, a blur, and the inset
  top-light highlight (the specular line). Apply it as the utility — never
  re-declare its backdrop-filter, border, or box-shadow by hand, and never
  invent a second glass recipe; dark mode is handled inside `.dark .glass`.
- **Content panels** use the shared translucent treatment, not full `glass`:
  `rounded-lg border border-border/70 bg-surface-raised/70 backdrop-blur-md`
  — i.e. the `PANEL` constant. Panels are legible data surfaces; the gloss
  stays subtle behind them.
- Surface hierarchy comes from the tokens: `surface` (window base) →
  `surface-raised` (panels) → `surface-sunken` (wells, tracks). Don't fake
  elevation with random `shadow-*` values; the primitives' own shadows plus
  the glass inset highlight are the only sanctioned shadow sources.
- The macOS vibrancy gradient is CSS-side in `index.css` under
  `body[data-platform="macos"]`. It does not get re-implemented per component,
  and translucent surfaces must never assume it exists — Windows and Linux
  render the same components over opaque tokens.
- Utility classes in JSX; no CSS files, no CSS-in-JS library, no inline
  `style` objects except for genuinely dynamic values (a measured bar width)
  that cannot be expressed as a utility. No `@apply` in components; only in
  `index.css` base layer where it already lives.
- Responsive by default: this app ships to desktop *and* a compact widget
  surface, so every view must hold up at narrow widths.