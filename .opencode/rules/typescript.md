# TypeScript Rules (client)

Applies to all TypeScript in the Tauri client: `app/src/**`, plus
`app/e2e/**`, `app/scripts/**`, `app/vite.config.ts`. Rust is covered by
[`rust.md`](rust.md), the Tauri shell by [`tauri.md`](tauri.md), components and
styling by [`ui.md`](ui.md).

The client is a **local desktop renderer with no server of its own**. It has no
API routes, no database, no auth layer. Anything that looks like one of those
belongs in Rust or is not in scope.

## Toolchain

- Runtime and package manager is **Bun** (1.4.2). Run every JS command from
  `app/`. Prefer `bun run <script>`; do not introduce npm/yarn/pnpm lockfiles.
- TypeScript `~6.0.3`. Vite `^8`, `moduleResolution: "bundler"`,
  `module: "ESNext"`, `jsx: "react-jsx"`.
- `app/tsconfig.json` is **strict, and it stays strict**:
  `strict`, `noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`, `isolatedModules`, `useDefineForClassFields`,
  `skipLibCheck`. `noEmit` is set, which is what makes `bun run build` a real
  typecheck. Do not relax a flag to make a new error disappear; fix the code.
- `app/tsconfig.node.json` is `composite` and covers only `vite.config.ts`.
  Adding a Node-side file (e.g. a script) means widening its `include` —
  do not move app code into it.
- Never add `// @ts-expect-error` to silence an error you have not understood,
  and never widen a type with `any`. `unknown` plus narrowing is the default
  answer for anything from the IPC boundary.

## Build & gates

```sh
cd app
bun run build     # tsc && vite build — the typecheck gate
bun run dev       # Vite only, port 1420 (no native shell)
bun run start     # native app: tauri dev
bun run restart   # stop app-owned processes, then start
bun run e2e       # build binary + wdio suite
```

`bun run build` runs `tsc`, and `tsconfig.json` sets `noEmit` — so
**`bun run build` is the typecheck**. A green Vite build means nothing on its
own; a green `bun run build` means the types are clean.

- Never introduce `eslint`, `prettier`, or a second formatter without
  approval. There is no linter configured today; `tsc` plus `cargo clippy` are
  the static gates, and formatting follows the surrounding file.
- `bun run clean`, `clean:rust`, `clean:frontend` remove build output. Prefer
  `bun run restart` over killing processes by hand — it also asserts ports
  1420/1421 are free before relaunching.

## Module structure

```
app/src/
  main.tsx              # entry: @wdio/tauri-plugin import + React root
  App.tsx               # shell/layout composition only
  index.css             # Tailwind 4 theme + tokens
  components/ui/        # vendored shadcn primitives
  components/<area>/    # app components grouped by feature
  lib/ipc.ts            # typed invoke wrappers — the ONLY place invoke() is called
  lib/utils.ts          # cn()
  lib/<provider>.ts     # per-provider data access + normalisation
  hooks/use<Name>.ts    # one hook per file
  types/<domain>.ts     # shared domain types
```

- Imports flow **inward only**: components → hooks → `lib` → types. Never the
  reverse; no feature module may import another feature's internals.
- Keep `App.tsx` a composition shell. Feature logic goes into
  `components/<area>/` or a hook — a growing `App.tsx` is the signal to split.
- Names follow [`naming-convention.md`](naming-convention.md) — kebab-case
  `.tsx` components, `useX.ts` hooks, `<name>.types.ts` for shared types.

## Types & data modelling

- Model the four data states as a discriminated union, not a nullable field:

  ```ts
  type UsageSnapshot =
    | { status: "live"; value: number; fetchedAt: number; source: string }
    | { status: "cached"; value: number; fetchedAt: number; source: string }
    | { status: "stale"; value: number; fetchedAt: number; source: string }
    | { status: "unavailable"; reason: string };
  ```

  This makes it impossible to render a usage number without its provenance,
  which is a hard requirement in `AGENTS.md`. See [`ui.md`](ui.md).
- Shared domain types live in `types/`, use `PascalCase` with **no `I`/`T`
  prefix**, and are declared with `interface` for objects and `type` for
  unions. Domain names first (`UsageSnapshot`, `ProviderStatus`,
  `RateLimitWindow`) — never generic containers (`Data`, `Info`, `Item`).
- Rust command payloads are mirrored by TS types in `lib/ipc.ts`. Keep the two
  in sync: a field renamed in `#[derive(Serialize)]` must be renamed here, or
  the value is silently `undefined` at runtime.
- Dates across the boundary are **epoch milliseconds (`number`)**, formatted
  only at render. Never ship a preformatted string from Rust.

## React specifics

- Function components, hooks in this order: built-ins → custom hooks →
  effects → early returns. Callbacks need a dependency array; an effect that
  runs on every render is a bug, not a style choice.
- Derive state during render instead of mirroring props into `useState`.
- Custom hooks return a stable, documented shape. If a hook needs a lot of
  call-site ceremony, the abstraction is in the wrong place.
- Never mutate props, state, or an `invoke` result.
- `useEffect` cleanup must release anything it acquired — polling intervals,
  `AbortController`, event listeners. Polling belongs in one place (a hook), and
  must not run when the window is hidden.
- Effects that talk to Rust handle **three** outcomes: resolved, rejected
  (a typed IPC error → rendered unavailable state), and stale response ignored
  (guard against out-of-order replies by tracking the latest request).
- No `dangerouslySetInnerHTML`. There is no content pipeline that needs it, and
  provider responses must never be injected as markup (see [`security.md`](security.md)).

## E2E specs & scripts

- `app/e2e/specs/*.e2e.ts` is the only automated test surface today. Specs
  import from `@wdio/globals` (`expect`, `browser`, `$`), never from the global
  namespace, and are read before extending — see the `tauri-e2e-testing` skill.
- **A UI change requires a spec here.** TDD is the default for every change, and
  any change to what the user sees or does is unfinished until an e2e spec
  asserts the rendered result and `bun run e2e` has run green. Type-checking and
  a passing build are not coverage for a UI change. Binding rules:
  [`testing.md`](testing.md).
- `capabilities.e2e.ts` is a **harness self-test**. It is not product coverage;
  a failure there invalidates the whole run.
- `app/scripts/*.ts` run under Bun. Use `Bun.spawn`/`execFileSync` and
  `import.meta.dir`, never `process.cwd()`, and never assume a POSIX shell —
  `restart.ts` is the cross-platform reference (Windows `powershell.exe` and
  `taskkill`, POSIX `ps`/`SIGTERM`/`SIGKILL`).
- Scripts must be idempotent and safe to re-run; they kill only processes whose
  command line contains the app root, never a broader match.

## Dependencies

- **Never add, remove, or upgrade a dependency without explicit user
  approval** — name, version, and why, then wait. This covers `dependencies`,
  `devDependencies`, and every Cargo crate.
- New releases are blocked for 15 days by `app/bunfig.toml`
  (`minimumReleaseAge`); see [`dependency-updates.md`](dependency-updates.md).
- There is **no unit-test runner** in the client today (no Vitest/Jest). Adding
  one is a dependency addition and therefore approval-gated — say so rather
  than reaching for an ad-hoc script. Pure helpers still get covered through
  the e2e suite or an explicitly approved runner.
- Prefer what is already installed. `clsx`, `tailwind-merge`, `cva`, `radix-ui`,
  and `lucide-react` cover the vast majority of UI needs; a new date library,
  state library, or HTTP client needs a strong reason.
- The client makes **no direct HTTP requests**. Network access belongs to Rust
  (provider APIs). Do not add `fetch` to the renderer for provider data.
- Commit `app/bun.lock` with dependency changes; never hand-edit it.

## Style

- 2-space indent, double quotes, semicolons — match the surrounding file.
- Comments follow [`documentation.md`](documentation.md): no narration of
  _what_, doc comments only for real contracts.
- Exports: prefer a named export. Only entry points (`App.tsx`, `main.tsx`) use
  a default export, matching what the Tauri scaffold generates.