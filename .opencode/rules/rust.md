# Rust Rules

Applies to all Rust in this repo — `app/src-tauri/src/**`, `app/src-tauri/crates/**`
and `app/src-tauri/build.rs`. This is a **Tauri desktop backend**: IPC commands,
provider integrations, local state and persistence. There is no HTTP server, no
diesel, no PostgreSQL, no tokio runtime of our own — Tauri supplies the async
runtime. Shell/IPC specifics are in [`tauri.md`](tauri.md).

The codebase is a layered, acyclic workspace built for scale — see
[Architecture](#architecture) below. That section is binding: placing code in
the wrong tier is the defect this file exists to prevent.

## Toolchain & formatting

- **Edition 2021** (per `app/src-tauri/Cargo.toml`). Do not bump it, and do not
  use edition-2024-gated features.
- No `rust-toolchain.toml`, no `rustfmt.toml`, no `clippy.toml` exist. Use the
  installed stable toolchain and default rustfmt/clippy settings; do not add a
  pin or a config file without explicit instruction.
- The crate is a `staticlib` + `cdylib` + `rlib` triple (lib name `agentgauge_lib`,
  bin `main.rs`). Mobile entries use `#[cfg_attr(mobile, tauri::mobile_entry_point)]` —
  preserve them.
- `panic = "abort"` in the release profile is deliberate. Do not reintroduce
  unwinding panics, and never rely on `catch_unwind` in release.
- `cargo clean -p agentgauge` does **not** clear `tauri-build`'s cached output. When
  a rebuild serves stale assets, `touch app/src-tauri/build.rs` (or run
  `bun run e2e:build`, which does it) — see [`tauri.md`](tauri.md).

## Architecture

The Rust side is a **layered, strictly acyclic workspace**. Getting a symbol
into the right tier is the single most important structural decision here;
everything else in this file is downstream of it.

```
app/src-tauri/
  Cargo.toml                  # workspace root: app package `agentgauge` (lib `agentgauge_lib`)
  crates/                     # independent library crates, one bounded concern each
    <crate-name>/
      Cargo.toml
      src/lib.rs
  src/
    main.rs                   # entry point only: #![cfg_attr] attrs + agentgauge_lib::run()
    lib.rs                    # composition root ONLY: plugins, state, wiring, handler
    modules/                  # application modules — one per bounded capability
      <module-name>/
        mod.rs
    shared/                   # cross-module primitives consumed by 2+ modules
      <area>/
        mod.rs
```

### Tiers and dependency direction

| Tier         | Path             | Owns                                                                 | May depend on        |
| ------------ | ---------------- | -------------------------------------------------------------------- | -------------------- |
| Composition  | `src/lib.rs`, `src/main.rs` | plugin registration, `tauri::State` construction, `generate_handler!` | `modules`   |
| Modules      | `src/modules/**` | one bounded business capability: `providers`, `poller`, `settings`, `widget` | `shared`, `crates` |
| Shared       | `src/shared/**`  | app-wide primitives: domain types, error taxonomy, clock, telemetry, config | `crates` |
| Crates       | `crates/**`      | reusable, self-contained logic — heavy deps, platform-specific builds, logic testable without a Tauri runtime | other `crates` |

- **Dependencies point downward only**: Composition → Modules → Shared →
  Crates. Never upward, never sideways between sibling modules.
- `shared/` must never import from `modules/`. That is an inverted dependency
  and guarantees a cycle. When shared code needs module behaviour, invert it
  with a trait defined in `shared/` and implemented in the module.
- Sibling modules must not import each other directly. If `poller` needs
  `providers`, go through a trait or a type re-exported from `shared/`.
- `crates/**` must never depend on `agentgauge` or `agentgauge_lib`. A crate must build and
  test standalone — `cargo test -p <crate>` passes with no Tauri app in the
  picture. If a "crate" needs `#[tauri::command]` or `tauri::State`, it is a
  module, not a crate.
- `main.rs` stays minimal: `#![cfg_attr]` attributes plus `agentgauge_lib::run()`.

### `lib.rs` is a composition root, nothing more

- `lib.rs` owns plugin registration, `tauri::Builder`, managed state
  construction, and `generate_handler![...]`.
- **No business logic, no HTTP calls, no parsing, no provider rules in
  `lib.rs`.** If `lib.rs` needs an `if` that is about domain behaviour, that
  logic belongs in a module.
- `#[tauri::command]` functions are `pub(crate)` at most and stay in
  `src/modules/**`; `lib.rs` only names them in `generate_handler!`. A command
  that grows real logic is doing its job wrong — see
  [Commands & types](#commands--types).
- Introducing a module or crate means adding its `mod` declaration here (and
  wiring it into the builder/handler). That is the only edit `lib.rs` should
  ever need.

### Module anatomy

A module is a **bounded capability**, not a file dump. One directory per
capability, `mod.rs` as its public surface:

```rust
// src/modules/providers/mod.rs
//! Provider integrations: one implementation per provider, plus the registry
//! that resolves a `Provider` trait object. Domain types live in
//! `crate::shared::domain`; nothing here is provider-agnostic state.

mod claude_code;
mod codex;
mod z_ai;

use crate::shared::domain::{UsageSnapshot, UsageSource};
use crate::shared::error::Error;
use crate::shared::provider::Provider;

pub use claude_code::ClaudeCodeProvider;
pub use codex::CodexProvider;

/// Resolves a provider by kind and owns its lifetime.
pub struct ProviderRegistry {
    // ... `Box<dyn Provider>` entries keyed by provider kind
}

impl ProviderRegistry {
    pub fn snapshot(&self, kind: ProviderKind) -> Result<UsageSnapshot, Error> {
        // delegate to the registered implementation; no branching on kind here
    }
}
```

- `mod.rs` declares submodules and re-exports. Callers import from
  `crate::modules::providers::…`, never from a leaf file — a leaf must be
  replaceable without touching callers.
- Keep implementation details private: `mod` items stay private and surface
  through `pub use`. Start private, widen only when a second caller needs it.
  No `pub` item that is an internal detail.
- A module owns its own errors (see [Commands & types](#commands--types)) and
  its tests; it must be unit-testable without booting Tauri.
- **Traits it implements come from `shared/`, not from `modules/`.** Put
  `Provider` in `shared/provider/` when more than one module consumes it, so
  `poller` depends on the trait and not on `providers`. A trait used by exactly
  one caller stays private to that module.

### `shared/` is for genuinely shared primitives

Put something in `shared/` only when **2+ modules** need it, and only if it is
a primitive, not a capability. Typical: domain value types, the shared error
taxonomy, a clock/timer abstraction, config loading, telemetry/logging setup,
cache primitives.

Do **not** move a whole capability into `shared/` because it is "important".
Shared is the narrowest tier; it is not a dumping ground between Modules and
Crates.

### The promotion ladder

Placing code is a promotion decision. Start at the lowest tier that works and
move up only on evidence — never pre-build a layer for code that does not exist
yet.

| Code that…                                        | Lives in                              |
| ------------------------------------------------- | ------------------------------------- |
| has one caller                                    | private in the calling module (`fn`)  |
| is a domain type / trait / error 2+ modules need  | `src/shared/<area>/`                  |
| is one bounded capability                         | `src/modules/<name>/`                 |
| needs a heavy dep, platform gating, or tests with no Tauri runtime | `crates/<name>/` |

Move a step up when the trigger fires, in the same change that fires it — do not
leave code parked in the wrong tier "for later". Moving down is always allowed
and needs no justification.

### `crates/` — the workspace

- `crates/` holds library crates consumed by the app via **path**
  dependencies: `foo = { path = "crates/foo" }`. Never a git or registry
  dependency for an in-repo crate.
- One crate = one bounded concern with a name that says what it is
  (`http-retry`, `keychain`, `cache`, `usage-model`). The directory and
  `package.name` are the Cargo `kebab-case` form; the Rust identifier you `use`
  is the `snake_case` form (`http_retry`).
- Extract to a crate when the code needs one of: a heavyweight dependency the
  app should not pay for everywhere, platform-conditional compilation, its own
  test suite that must not drag in Tauri, or reuse beyond this app.
- **Keep the app crate minimal.** Every dependency added to `agentgauge` is compiled
  into the desktop binary on every platform; push it into a crate first when
  the choice exists.
- The app crate `Cargo.toml` is the workspace root. When you create the first
  crate, add `[workspace] members = ["crates/<name>"]` (and `resolver = "2"`).
  An empty `members = ["crates/*"]` glob with no crates present is a Cargo
  error — list members explicitly, or add them as you go.
- Crate-local `Cargo.lock` files must not be committed; the workspace
  `app/src-tauri/Cargo.lock` is the single lockfile.
- Crates carry `#![forbid(unsafe_code)]` and `#![warn(missing_docs)]` unless
  there is a documented reason not to.

### Provider modularity

`AGENTS.md` requires provider modularity, and it drives the tiering above:

- One module per provider under `src/modules/providers/` (`codex.rs`,
  `claude_code.rs`, `z_ai.rs`). The `Provider` trait and the domain types it
  speaks in live in `src/shared/`; `providers/mod.rs` holds the registry and
  the implementations.
- Providers are **trait objects behind a registry**, not `match` statements
  sprinkled through callers. Adding a provider must not require editing
  `lib.rs`, `poller`, or any shared code beyond one registration line.
- Provider-specific types never leak into command signatures or `shared/`
  domain types — the boundary returns the shared domain types, so the UI's
  contract stays provider-agnostic.

### Designing for growth

These are the mechanisms that keep the app scalable as providers multiply:

- **Seams over conditionals.** Every cross-capability interaction goes
  through a trait (`Provider`, `Cache`, `Clock`, `SecretStore`) defined in
  `shared/` and implemented in the owning module or crate. Tests substitute a
  fake; production substitutes the real one.
- **One error taxonomy.** `shared::error::Error` is the app's root error;
  each module defines its own concrete enum and converts with `#[from]`.
  Callers match on variants, never on message strings.
- **Explicit configuration.** Load config once in a `shared::config` module
  and pass typed values down. No module reaches for a global or reads the
  environment directly.
- **Explicit background-task lifecycle.** Every spawned poller/monitor gets a
  shutdown signal (a `watch`/`oneshot` channel or a `CancellationToken`) and is
  started from exactly one place, so it cannot double-start or outlive the
  window.
- **Provenance in the data model.** Domain types carry source and update time
  (live / cached / stale / unavailable) as fields, not as something the UI
  infers — see `AGENTS.md`.
- **Idempotent, restartable work.** A poller resuming after restart must not
  corrupt state; persist what it needs through a module, never ad hoc.

## Dependencies

- **Never add or upgrade a crate without explicit user approval** — name,
  version, features, why, then wait. This covers new crates under
  `app/src-tauri/crates/` too: creating one is an approval-gated decision, not
  a drive-by refactor.
- Current crates are deliberately minimal: `tauri`, `tauri-plugin-opener`,
  `serde`, `serde_json`, plus the two `tauri-plugin-wdio*` crates used **only**
  by the e2e harness. Keep it that way; each crate must earn its compile time
  and binary size.
- In-repo crates are **path dependencies** (`{ path = "crates/<name>" }`) and
  follow the downward-only direction in
  [Architecture](#architecture). A crate must never depend on another module's
  internals or back on the app crate.
- Give a heavy or niche dependency to the **crate that needs it**, not to `agentgauge`.
  A dependency added to the app crate is linked into every platform build; one
  added to a crate is scoped to what actually uses it.
- Feature flags are additive and narrow: never enable a feature "to make it
  compile" if it widens the release surface.
- `tauri-plugin-wdio` and `tauri-plugin-wdio-webdriver` are test-only. They must
  stay registered behind `#[cfg(debug_assertions)]` and must never appear in a
  release build path.
- The `custom-protocol` feature is what makes the debug e2e binary embed the
  frontend. Do not remove it from `[features]`.
- Commit `app/src-tauri/Cargo.lock` with dependency changes; never hand-edit it.

## Commands & types

- Every `#[tauri::command]` is untrusted input crossing a process boundary:
  validate/coerce with serde at the boundary. Return typed structs, never
  ad-hoc tuples or `HashMap`s the UI must interpret. See [`tauri.md`](tauri.md).
- Commands live in `src/modules/**` (or a leaf they delegate to) and are
  registered in `lib.rs`. They are `pub(crate)` at most and exist only to
  marshal IPC, not to hold logic.
- **Command body shape is always the same three steps**: validate arguments →
  delegate to the owning module → map the error into the shared IPC error
  shape. No provider HTTP calls, no JSON parsing, no filesystem work inline.
- Errors: each module defines one concrete error enum implementing
  `std::error::Error` + `Display`, converting up into `shared::error::Error`
  with `#[from]` or `.map_err(...)`. Never `Box<dyn Error>` unless truly
  heterogeneous, and never a bare `String` error. Deriving with `thiserror` is
  fine **once that crate is approved** — it is not a dependency today, so do
  not add it as a drive-by.
- A command error crossing IPC must serialize to something the client can
  branch on without string-matching (a tagged `{ kind, message }` shape, never
  a bare string). Include actionable context, never secrets or raw provider
  response bodies in the message.
- Commands return **shared domain types**, never provider-specific ones, so the
  UI contract stays stable as providers are added.
- `Result<T, E>` throughout; no panics on expected failures.

## Errors & panics

- No `unwrap()`, `expect()`, or indexing that can panic outside tests and
  `main.rs` startup. Use `?`, `match`, or `.unwrap_or*`/`.ok_or*`.
- Where an invariant is truly unreachable, document **why** it is unreachable
  in a `//` comment next to the `unwrap`.
- No `unsafe` unless a documented, unavoidable reason is approved by the
  maintainer; if required, isolate it, minimise it, cover it with a test, and
  attach a `// SAFETY:` comment justifying every invariant.
- Never log secrets, tokens, or full provider response payloads. Provider
  failures log an error code and enough to diagnose — never credentials.

## Concurrency & state

- Tauri provides the async runtime. Do not add tokio directly; use
  `tauri::async_runtime::spawn` / `tokio` features already re-exported.
- Shared mutable state goes through `tauri::State<T>` with a `Mutex`/`RwLock`.
  **Never hold a lock guard across `.await`** — it deadlocks the runtime.
  Scope the guard, copy/clone out, then await.
- Construct managed state once in `lib.rs` (the composition root) and pass the
  concrete type into the owning module's constructor — modules read their
  dependencies, they do not build them.
- Blocking I/O or CPU-heavy work goes to `spawn_blocking`; never block the
  async executor.
- Long-running monitors/polling belong in a dedicated spawned task with clean
  shutdown, not in a command. Poll on an interval, and stop when the window is
  hidden or the app exits (see the client polling rules in
  [`typescript.md`](typescript.md)).
- Every spawned task has an owned, explicit shutdown path (a `CancellationToken`,
  a `watch`/`oneshot` channel, or a stop flag the owner checks) and is started
  from exactly one place. A task that cannot be stopped is a leak and a bug.
- Prefer `&str`/borrowed parameters over owned unless ownership is required;
  avoid needless `.clone()`/`.to_string()` on hot paths.

## Style

- Follow the [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/naming.html)
  for casing — `snake_case` functions/modules, `PascalCase` types, `SCREAMING_SNAKE_CASE`
  consts; see [`naming-convention.md`](naming-convention.md).
- Comments follow [`documentation.md`](documentation.md): rustdoc `///` on public
  items, `//!` for module docs — and no inline `//` comments except the
  critical cases (unreachable-invariant notes, `// SAFETY:` blocks, non-obvious
  platform workarounds).
- Every module and crate gets a `//!` doc comment stating what it owns and,
  when it is not obvious, what it explicitly does **not** own.
- Prefer iterators, slices, and early returns over index juggling and deep
  nesting.
- Keep command bodies thin: parse → delegate to a module → map the error. No
  provider HTTP calls or parsing inline in a command.

## Tests

TDD is the default for every change. Write the failing test first, confirm it
fails for the intended reason, then implement.

- Unit tests inline under `#[cfg(test)] mod tests` in the module they cover;
  integration tests in `app/src-tauri/tests/`. Run with
  `cargo test --manifest-path app/src-tauri/Cargo.toml`.
- **Test at the lowest tier that owns the behaviour.** Pure logic in a crate
  gets `cargo test -p <crate>` with no Tauri present; a module gets inline unit
  tests; only genuinely IPC-shaped behaviour needs an e2e spec. Do not pay for a
  full app build to test a pure function.
- Crate tests must not require the app crate: `cargo test -p <crate>` passes
  standalone. If a crate's tests need Tauri, the code is in the wrong tier.
- Cover error branches, not just the happy path. Use temp fixtures; never touch
  the developer's real data or repo state.
- Design for testability: inject seams (traits for clock, HTTP, cache, secret
  store) so tests substitute fakes instead of sleeping on real timers or real
  network calls.
- A `#[tauri::command]`'s **returned value and error serialization** are the
  contract the client branches on. If a command is new or its behaviour changed,
  a spec in `app/e2e/specs/features/` must assert it — commands with no coverage are the
  usual source of "the UI shows nothing" defects. Reach the command with
  `browser.tauri.execute(({ core }) => core.invoke(...))` when no UI gesture
  triggers it.
- A change to anything the user sees requires e2e coverage; a passing
  `cargo check` cannot show that. Binding rules: [`testing.md`](testing.md).

## Warnings

- **Zero warnings.** `cargo check` and
  `cargo clippy --all-targets -- -D warnings` must be clean. Never add
  `#[allow(...)]` to silence a warning you have not understood — fix it or
  document the deliberate reason.
