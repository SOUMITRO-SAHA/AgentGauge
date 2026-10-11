# Naming Conventions

Governs files and symbols in this repo. Apply whenever you create a file or
add code. Two languages are in use: **Rust** (`app/src-tauri/src`,
`app/src-tauri/crates`) and **TypeScript/React** (`app/src`, `app/e2e`,
`app/scripts`). `website/` is an uninitialised Astro placeholder — when it
exists, see [`astro.md`](astro.md).

`cargo fmt` and the shadcn/upstream component conventions enforce most of this
automatically. The rules below are what no tool enforces.

## Rust

Follow the [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/naming.html);
there are no project-specific overrides.

- Files and modules: `snake_case` — `provider_registry.rs`, `rate_limit.rs`.
- Types, traits, enums: `PascalCase` — `ProviderStatus`, `UsageSnapshot`, `RateLimitWindow`.
- Functions, methods, variables, fields: `snake_case`.
- Consts and statics: `SCREAMING_SNAKE_CASE`.
- Crates: the app package is `agentgauge` (lib `agentgauge_lib`). A crate in
  `app/src-tauri/crates/` takes the short name of the concern it owns —
  `http_retry`, `keychain`, `usage_model` — so name it for the concern, never
  for the layer (`utils`, `helpers`, `common` are not crate names). The
  directory and `package.name` are the Cargo `kebab-case` form
  (`http-retry`); the Rust identifier is the `snake_case` form (`http_retry`),
  which is what you `use`.
- Module directories use `mod.rs`, named for the **capability**:
  `modules/providers/mod.rs`, `modules/poller/mod.rs`, `shared/domain/mod.rs`.
- Provider modules are named for the provider, lowercase: `codex.rs`,
  `claude_code.rs`, `z_ai.rs`.

## TypeScript & React

**Files: kebab-case, with a role suffix carrying one role per file.**

| Kind                       | File name             | Example                                   |
| -------------------------- | --------------------- | ----------------------------------------- |
| App React component        | `<name>.tsx`          | `UsageCard` in `usage-card.tsx`           |
| React hook                 | `useHookName.ts`      | `useUsage` in `useUsage.ts`               |
| shadcn / Radix primitive   | `<name>.tsx`          | `button` in `components/ui/button.tsx`    |
| Typed IPC wrapper / module | `<name>.ts`           | `ipc.ts`, `codex.ts`                      |
| Effect service + layer     | `<name>.service.ts`   | `usageReader.service.ts`                  |
| Atom (state)               | `<name>.atom.ts`      | `usage.atom.ts`                           |
| Schema (IPC boundary)      | `<name>.schema.ts`    | `usage.schema.ts`                         |
| Shared types               | `<name>.types.ts`     | `usage.types.ts`                          |
| Pure helpers               | `<name>.utils.ts`     | `formatUsage.utils.ts`                    |
| Constants / query keys     | `<name>.constants.ts` | `refresh.constants.ts`                    |
| E2E spec                   | `<feature>.e2e.ts`    | `dashboard.e2e.ts`, `capabilities.e2e.ts` |
| Vite / toolchain config    | framework name        | `vite.config.ts`                          |

- **React components are the kebab-case `.tsx` family** — this is what shadcn
  generates and what already exists (`components/ui/button.tsx`), so stay
  consistent with the CLI or generated files drift from your code.
- **Hooks: exactly one hook per file, named verbatim after the hook** —
  `useUsage.ts` exports `useUsage`. Never `use-usage.ts`, never
  `useUsage.hook.ts`, and never several hooks or an extra role (types → `.types.ts`,
  helpers → `.utils.ts`, keys → `.constants.ts`) riding along.
- Framework-fixed names are exempt from the role suffix: `main.tsx`, `App.tsx`
  (root shell, matched by the scaffold), `vite-env.d.ts`, and
  `e2e/wdio.conf.ts` (matched by the `wdio` CLI).
- Folders stay kebab-case (`components/usage/`, `e2e/specs/features/`, `lib/`).
- Files predating these rules are grandfathered until touched — rename to the
  current scheme when you significantly edit one.

### Symbols

- Components: `PascalCase`, matching the file's default export — `UsageCard` in
  `usage-card.tsx`.
- Effect services: `PascalCase` extending `Context.Service`, named for the
  capability it provides — `UsageReader`, `Poller`. Its layer is a `static
readonly layer` member; a test double is `static readonly layerTest`.
- Atoms: `PascalCase` suffixed `Atom` — `usageAtom`, `providerStatusAtom`.
  Services that read other atoms are `usageByProviderAtom`.
- Interfaces: `PascalCase`, **no `I` prefix** — `UsageSnapshot`, `CardProps`.
  (Type aliases use `type` for unions, `interface` for objects.)
- Type aliases and unions: `PascalCase`, **no `T` prefix** — `UsageState`,
  `ProviderKind`. These are **domain** names, not containers: `UsageSnapshot`
  and not `TData`.
- Typed errors: `PascalCase` ending `Error` — `UsageError`, `IpcError`.
- Hooks: `use` prefix + PascalCase — `useUsage`, `useProviderStatus`.
- Variables, functions, parameters: `camelCase`.
- Compile-time constants only: `SCREAMING_SNAKE_CASE` (`REFRESH_INTERVAL_MS`).
  Everything else camelCase.
- IPC command names: `snake_case` and stable — they are the cross-language
  contract between `#[tauri::command]` and `invoke()`. Renaming one is a
  breaking change to both sides.

## Cross-boundary consistency

The IPC boundary is the one place where Rust and TypeScript names must agree:
the command name, its argument keys (camelCase in TS ↔ serde in Rust), and its
return type. When you rename on one side, rename on the other in the same
change — a silent mismatch shows up only as `undefined` at runtime. See
[`tauri.md`](tauri.md).

## Markdown, assets, and config

- Docs and task notes: `kebab-case.md` (`code-review.md`, `astro.md`).
- Icons and image assets follow Tauri's required names exactly — do not
  rename files listed in `bundle.icon` (`128x128@2x.png`, `icon.icns`,
  `StoreLogo.png`); see [`logo-generation.md`](logo-generation.md).
- Config keys come from the owning tool (`tauri.conf.json`, `Cargo.toml`,
  `bunfig.toml`) — never renamed by hand.

## Rust/TypeScript quick reference

| Kind             | Name                                  | Example                                   |
| ---------------- | ------------------------------------- | ----------------------------------------- |
| Rust module      | `snake_case.rs`                       | `modules/providers/codex.rs`              |
| Rust type / enum | `PascalCase`                          | `UsageSnapshot`                           |
| Rust const       | `SCREAMING_SNAKE_CASE`                | `MAX_PROVIDERS`                           |
| Rust crate       | `kebab-case` dir / `snake_case` ident | `crates/http-retry/` used as `http_retry` |
| Rust fn          | `snake_case`                          | `fetch_usage`                             |
| IPC command name | `snake_case`                          | `get_usage`                               |
| React component  | `kebab-case.tsx`                      | `UsageCard` in `usage-card.tsx`           |
| React hook       | `useHookName.ts`                      | `useUsage` in `useUsage.ts`               |
| Shared types     | `<name>.types.ts`                     | `UsageSnapshot` in `usage.types.ts`       |
| Pure helpers     | `<name>.utils.ts`                     | `format.ts` in `format.utils.ts`          |
| E2E spec         | `<name>.e2e.ts`                       | `app.e2e.ts`                              |
| Doc / rule file  | `kebab-case.md`                       | `code-review.md`                          |
