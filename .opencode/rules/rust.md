# Rust Rules

Applies to all Rust in this repo — today `app/src-tauri/src/**` and
`app/src-tauri/build.rs`. This is a **Tauri desktop backend**: IPC commands,
provider integrations, local state and persistence. There is no HTTP server, no
diesel, no PostgreSQL, no tokio runtime of our own — Tauri supplies the async
runtime. Shell/IPC specifics are in [`tauri.md`](tauri.md).

## Toolchain & formatting

- **Edition 2021** (per `app/src-tauri/Cargo.toml`). Do not bump it, and do not
  use edition-2024-gated features.
- No `rust-toolchain.toml`, no `rustfmt.toml`, no `clippy.toml` exist. Use the
  installed stable toolchain and default rustfmt/clippy settings; do not add a
  pin or a config file without explicit instruction.
- The crate is a `staticlib` + `cdylib` + `rlib` triple (lib name `ism_lib`,
  bin `main.rs`). Mobile entries use `#[cfg_attr(mobile, tauri::mobile_entry_point)]` —
  preserve them.
- `panic = "abort"` in the release profile is deliberate. Do not reintroduce
  unwinding panics, and never rely on `catch_unwind` in release.
- `cargo clean -p aism` does **not** clear `tauri-build`'s cached output. When
  a rebuild serves stale assets, `touch app/src-tauri/build.rs` (or run
  `bun run e2e:build`, which does it) — see [`tauri.md`](tauri.md).

## Layout

```
app/src-tauri/src/
  main.rs      # thin: #![cfg_attr] attributes + aism_lib::run()
  lib.rs       # plugins, #[tauri::command]s, builder chain, generate_handler!
```

- `main.rs` stays minimal. Real work belongs in `lib.rs` or a module.
- As provider integrations arrive, split into modules **by provider**
  (`providers/codex.rs`, `providers/claude_code.rs`) with a shared
  `providers/mod.rs` defining the common trait. Do not couple provider-specific
  logic into general command or state code — `AGENTS.md` requires provider
  modularity.
- Start private, widen only when a second caller needs it. No `pub` item that
  is an internal detail.

## Dependencies

- **Never add or upgrade a crate without explicit user approval** — name,
  version, features, why, then wait.
- Current crates are deliberately minimal: `tauri`, `tauri-plugin-opener`,
  `serde`, `serde_json`, plus the two `tauri-plugin-wdio*` crates used **only**
  by the e2e harness. Keep it that way; each crate must earn its compile time
  and binary size.
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
- Errors: define one concrete error enum per module (or a shared `IsmError`)
  implementing `std::error::Error` + `Display`, and map into it with `#[from]`
  or `.map_err(...)`. Never `Box<dyn Error>` unless truly heterogeneous, and
  never a bare `String` error. Deriving with `thiserror` is fine **once that
  crate is approved** — it is not a dependency today, so do not add it as a
  drive-by.
- A command error crossing IPC must serialize to something the client can
  branch on without string-matching. Include actionable context, never secrets
  or raw provider response bodies in the message.
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
- Blocking I/O or CPU-heavy work goes to `spawn_blocking`; never block the
  async executor.
- Long-running monitors/polling belong in a dedicated spawned task with clean
  shutdown, not in a command. Poll on an interval, and stop when the window is
  hidden or the app exits (see the client polling rules in
  [`typescript.md`](typescript.md)).
- Prefer `&str`/borrowed parameters over owned unless ownership is required;
  avoid needless `.clone()`/`.to_string()` on hot paths.

## Style

- Follow the [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/naming.html)
  for casing — `snake_case` functions/modules, `PascalCase` types, `SCREAMING_SNAKE_CASE`
  consts; see [`naming-convention.md`](naming-convention.md).
- Comments follow [`documentation.md`](documentation.md): rustdoc `///` on public
  items, `//!` for module docs, `//` only for a non-obvious *why* (including
  the unreachable-invariant notes and `// SAFETY:` blocks).
- Prefer iterators, slices, and early returns over index juggling and deep
  nesting.
- Keep command bodies thin: parse → delegate to a provider module → map the
  error. No provider HTTP calls or parsing inline in a command.

## Warnings

- **Zero warnings.** `cargo check` and
  `cargo clippy --all-targets -- -D warnings` must be clean. Never add
  `#[allow(...)]` to silence a warning you have not understood — fix it or
  document the deliberate reason.