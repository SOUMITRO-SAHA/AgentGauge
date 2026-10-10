# TypeScript Rules (client)

Applies to all TypeScript in the Tauri client: `app/src/**`, plus `app/e2e/**`,
`app/scripts/**`, `app/vite.config.ts`.

**Effect is mandatory here.** All data access, async work, error handling, and
state go through it. The full API contract, version pins, and patterns are in
[`effect.md`](effect.md) — read that first for anything non-trivial. Rust is
covered by [`rust.md`](rust.md), the shell by [`tauri.md`](tauri.md), components
and styling by [`ui.md`](ui.md).

The client is a **local desktop renderer with no server of its own**: no API
routes, no database, no auth layer, no `fetch`. Anything that looks like one of
those belongs in Rust or is out of scope.

## Toolchain

- Runtime and package manager is **Bun**. Run every JS command from `app/`.
  Never introduce npm/yarn/pnpm lockfiles.
- TypeScript `~6.0.3`, Vite `^8`, React 19 (`19.3.0` resolved), `jsx:
  "react-jsx"`, `moduleResolution: "bundler"`.
- Effect `4.0.0-beta.107`, `@effect/atom-react@4.0.0-beta.107` — exact pins,
  never a range or a dist-tag. See [`effect.md`](effect.md) for why.
- `app/tsconfig.json` is **strict, and it stays strict**: `strict`,
  `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`,
  `isolatedModules`, `useDefineForClassFields`, `skipLibCheck`, and `noEmit`
  (which is what makes `bun run build` a real typecheck). Effect's generics make
  these flags more valuable, not less — never relax one to make an Effect type
  error go away.
- `app/tsconfig.node.json` is `composite` and covers only `vite.config.ts`.
  Widening it to reach new Node-side files is fine; do not move app code into it.
- Never add `// @ts-expect-error` on an Effect type you have not understood, and
  never widen to `any`. Fix the `R` or `E` channel instead.
- Never add ESLint or Prettier without approval. The static gates are `tsc` and
  `cargo clippy`.

## Build & gates

```sh
cd app
bun run build      # tsc && vite build — the typecheck gate
bun run test       # vitest unit + component suite (see testing.md)
bun run e2e        # builds the binary, then drives the real app
bun run dev        # Vite only, port 1420 (no native shell)
bun run start      # native app: tauri dev
bun run restart    # stop app-owned processes, assert 1420/1421 free, relaunch
```

`bun run build` runs `tsc` with `noEmit`, so **it is the typecheck**. A green
Vite build alone means nothing.

- Never run bare `vitest` against a stale transform and never bare `wdio` —
  use the scripts, they own their builds.
- `bun run clean`, `clean:rust`, `clean:frontend` remove build output. Prefer
  `bun run restart` over killing processes by hand.

## Module structure

```
app/src/
  main.tsx                     # entry: @wdio/tauri-plugin import + root, wrapped in RegistryProvider
  App.tsx                      # composition shell only
  index.css                    # Tailwind 4 theme + tokens
  components/ui/               # vendored shadcn primitives
  components/<area>/           # app components grouped by feature
  lib/
    runtime.ts                 # the app's Layers + ManagedRuntime (composition root)
    services/<name>.service.ts # Context.Service definitions + their Layer
    ipc.ts                     # the ONLY place invoke() is called; wrapped in Effect
    schemas/<domain>.schema.ts # Schema decoders for IPC payloads
    utils.ts                   # cn()
  providers/<name>/            # per-provider atoms + logic
  hooks/use<Name>.ts           # one hook per file, thin wrapper over atoms
  types/<domain>.types.ts      # shared domain types
```

- Imports flow **inward only**: components → hooks → `lib`/providers → types.
  Never the reverse; no feature module may import another feature's internals.
- `lib/runtime.ts` is the client's composition root, mirroring `lib.rs` on the
  Rust side: it builds the layer graph once and exports the runtime. Nothing
  else composes layers.
- `App.tsx` stays a composition shell. Feature logic lives in
  `components/<area>/`, an atom, or a hook — a growing `App.tsx` is the signal to
  split.
- Names follow [`naming-convention.md`](naming-convention.md).

## Types & data modelling

Two distinct layers of state, and conflating them is the most common mistake:

**1. Async state — `AsyncResult`, owned by Effect.** An effectful atom's value
is `Initial | Success | Failure`, each with `waiting`. Never wrap an
`AsyncResult` in your own `isLoading` boolean; read the tag. See
[`effect.md`](effect.md).

**2. Domain state — your own types, modelled as data.** Model a provider's
readiness explicitly so it is impossible to render a number without provenance:

```ts
type UsageSnapshot =
  | { readonly state: "live"; readonly value: number; readonly fetchedAt: number; readonly source: string }
  | { readonly state: "cached"; readonly value: number; readonly fetchedAt: number; readonly source: string }
  | { readonly state: "stale"; readonly value: number; readonly fetchedAt: number; readonly source: string }
  | { readonly state: "unavailable"; readonly reason: string }
```

This is what makes it impossible to render a usage number without its source and
time — a hard requirement in `AGENTS.md`. A **missing value is a rendered
state**, never `0`, `-`, an empty string, or a `?? 0` fallback that reads like
real data. See [`ui.md`](ui.md).

- Shared types use `PascalCase` with **no `I`/`T` prefix**, `interface` for
  objects and `type` for unions, and domain names (`UsageSnapshot`,
  `ProviderId`, `RateLimitWindow`) — never generic containers.
- `readonly` on domain types and service shapes: these are values, not
  mutable records.
- Where a type must cross the IPC boundary, define a `Schema` and derive the
  TypeScript type from it — one source of truth, decode-enforced. Do not
  hand-maintain a parallel interface.
- Timestamps across the boundary are **epoch milliseconds (`number`)**, formatted
  only at render. Never ship a preformatted string from Rust.

## React specifics

- Components read state through atoms (`useAtomValue`) and write through
  `useAtomSet`/`useAtomRefresh`. **`useState` is for ephemeral UI state only**
  (an open/closed flag, a text input). Mirroring fetched data into `useState`
  plus a `useEffect` is a bug, not a style choice — that is what atoms are for.
- Derive during render instead of storing derivable values.
- A component that needs a resource owns an atom (`ScopedAtom`), not a local
  effect that fetches on mount.
- Every effectful atom must handle all three `AsyncResult` branches. A component
  that ignores `Failure` is broken.
- Never `dangerouslySetInnerHTML`. Provider data is never markup. See
  [`security.md`](security.md).
- A custom hook is a thin, documented wrapper over atoms. If a hook needs a lot
  of call-site ceremony, the abstraction is in the wrong place.

## E2E specs & scripts

- `app/e2e/specs/*.e2e.ts` drives the real binary. Specs import from
  `@wdio/globals` (`expect`, `browser`, `$`) — never the global namespace.
  `capabilities.e2e.ts` is a harness self-test, not product coverage.
- `bun run e2e` owns the build; never bare `wdio`, never a bare `cargo build`.
  See the `tauri-e2e-testing` skill.
- Command mocking (`browser.tauri.mock`) still works with Effect: it patches
  `invoke` in the renderer, which is the exact seam `Effect.tryPromise` wraps.
  Set implementations in `beforeEach` — `mock()` fully resets on every call.
- `app/scripts/*.ts` run under Bun. Use `Bun.spawn`/`execFileSync` and
  `import.meta.dir`, never `process.cwd()`, and never assume a POSIX shell —
  `restart.ts` is the cross-platform reference.

## Dependencies

- **Never add, remove, or upgrade a dependency without explicit user
  approval** — name, version, why, then wait. Covers npm/Bun packages and Cargo
  crates alike.
- Releases under 15 days old are blocked by `app/bunfig.toml`. Effect's exact
  pins were chosen to satisfy that gate; see [`dependency-updates.md`](dependency-updates.md).
- There **is** a unit-test runner (vitest + `@effect/vitest` +
  `@testing-library/react` + jsdom). Full gate list and Effect test patterns:
  [`testing.md`](testing.md).
- Prefer what is installed. `clsx`, `tailwind-merge`, `cva`, `radix-ui`, and
  `lucide-react` cover most UI needs. **Effect means you do not need** a state
  library, a data-fetching library, a result library, or an HTTP client on the
  client side — proposing one is a sign Effect is being bypassed, and needs a
  stated reason.
- The client makes **no direct HTTP requests.** Network access belongs to Rust.
- Commit `app/bun.lock` with dependency changes; never hand-edit it.

## Style

- 2-space indent, double quotes, semicolons — match the surrounding file.
- Comments follow [`documentation.md`](documentation.md): no narration of
  _what_, JSDoc only for real contracts, and no inline `//` comments except
  the critical cases. Effect-specific conventions (span names on `Effect.fn`,
  why-comments on channel changes) are in [`effect.md`](effect.md).
- Named exports by default. Only entry points (`App.tsx`, `main.tsx`) use a
  default export, matching the Tauri scaffold.