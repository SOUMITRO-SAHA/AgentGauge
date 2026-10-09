# Rust Rules

These rules apply to all Rust code in this repo — today that is `apps/server` (`libryva_server`). Stack and layout specifics live in [`apps/server/AGENTS.md`](../../apps/server/AGENTS.md); this file defines the language-level rules.

## Toolchain & formatting

- No toolchain is pinned (`rust-toolchain.toml` does not exist). Use the installed stable toolchain; never introduce a pin or bump toolchain versions without explicit instruction.
- Edition 2024. Do not add edition-gated features without checking compatibility.
- Default `rustfmt` / `clippy` settings only — no `rustfmt.toml` or `clippy.toml` exists; do not add one without approval.

## Dependencies

- **Never add or upgrade a dependency without explicit user approval** — list crate name, version, features, and why, then wait (see golden rules in `apps/server/AGENTS.md`).
- Keep the dependency graph minimal; every crate must earn its compile time and binary size.
- Do not enable diesel's `postgres` backend feature (it pulls libpq/`pq-sys`); `diesel-async`'s `postgres` feature is the approved path.

## Safety

- No `unsafe` code unless there is a documented, unavoidable justification approved by the maintainer.
- If `unsafe` is ever required, it must be isolated, minimised and covered by tests plus a `// SAFETY:` comment explaining every invariant.

## Errors

- Typed errors only: handlers use the shared `ApiError` (thiserror); extracted crates define their own thiserror enum. Do not box errors unnecessarily.
- Handlers return `Result<Json<T>, ApiError>` and convert failures with `?` plus `#[from]` or `.map_err(...)` — e.g. `.map_err(|e| ApiError::Pool(e.to_string()))`.
- Provide useful, actionable error messages with context.
- No `unwrap`/`expect` outside tests and `main.rs` startup. Where an invariant violation is truly unreachable, document why in a `// why` comment.

## API design

- Prefer borrowed parameters over owned unless ownership is required.
- Keep public APIs minimal. Start private, widen only when needed.
- Avoid premature generics and trait indirection. Concrete first, abstract when duplication proves it.
- No `pub` items that are internal implementation details.
- Default to a module (`src/module/*`, `src/shared/*`); extract `crates/<name>` only per the decision table in `apps/server/AGENTS.md`.

## Style

- Comments and doc comments follow the canonical rule [documentation.rules.md](documentation.rules.md) — no narration of _what_, rustdoc `///` on public items and `//!` for module docs, plain `//` only for a non-obvious _why_ (including the unreachable-invariant notes required in [Errors](#errors)).
- Names follow Rust conventions exactly (`snake_case` functions, `CamelCase` types, `SCREAMING_SNAKE_CASE` consts) — see [naming-convention.md](naming-convention.md).
- Prefer iterators, slices and early returns over index juggling and deep nesting.
- Handlers stay thin: no business logic inline; query code uses the diesel DSL.

## Async & performance

- Never block the async executor: no blocking I/O or `std::thread::sleep` in handlers — use `tokio` primitives (`tokio::time::sleep`, `spawn_blocking` for CPU-bound work).
- Lazy over eager. Stream large responses instead of buffering them in memory. Every cache/pool is bounded by explicit config (deadpool sizes are config, not magic numbers).
- No unnecessary `.clone()` or `.to_string()` on hot paths.

## Database & migrations

- Migrations are hand-written SQL at `migrations/<version>_<name>/{up,down}.sql` (there is no `diesel_cli`). Every `up` gets a matching `down`.
- Never edit a migration that has been applied — add a new one.
- Keep `src/shared/schema.rs` (`table!` macros) in sync with the migration SQL once that file exists.

## Warnings

- Zero warnings: `cargo check` must finish with no errors and no warnings; clippy runs with `-D warnings`.
