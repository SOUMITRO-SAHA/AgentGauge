# Tauri Rules

Applies to the whole `app/` shell: `app/src-tauri/**` (Rust), `app/src/**`
(React client), and the boundary between them. Language-level rules live in
[`rust.md`](rust.md) and [`typescript.md`](typescript.md); this file covers
only what is specific to Tauri.

`AGENTS.md` is binding on feature claims: **the app is still the starter
greeting example**. Do not describe provider integrations, monitoring,
automation, or widget behavior as implemented unless the code does it.

## The five files that define the app

| File                                          | Owns                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `app/src-tauri/tauri.conf.json`               | product identity, window geometry, build wiring, CSP, bundle, icons |
| `app/src-tauri/capabilities/default.json`      | **the entire frontend permission surface**                          |
| `app/src-tauri/Cargo.toml`                     | workspace root: crates, `custom-protocol` feature, release profile  |
| `app/src-tauri/src/lib.rs`                     | **composition root** — plugins, managed state, `generate_handler!`  |
| `app/src/main.tsx`                            | `@wdio/tauri-plugin` import + React root                           |

Changing any of these can break the native shell, the e2e harness, or both.
Read this file before editing them.

`lib.rs` registers commands that live in `src/modules/**`; it contains no
business logic itself. `src/shared/**` and `crates/**` follow the dependency
rules in [`rust.md`](rust.md) and never appear in the builder chain.

## Commands (IPC)

- Every `#[tauri::command]` is **cross-process untrusted input**, no less than
  an HTTP endpoint — validate and coerce at the boundary with serde, never
  trust values downstream (see [`security.md`](security.md)).
- Arguments use `#[serde(rename_all = "camelCase")]` semantics by default;
  the TypeScript caller must pass camelCase keys. Keep the Rust type name and
  the TS payload in `app/src/lib/ipc.ts` (or the provider module) in sync —
  a silent mismatch surfaces only at runtime.
- Return typed structs (`serde` `Serialize`), not ad-hoc tuples or `HashMap`s
  whose key order matters. `Result<T, E>` where `E` serializes to something the
  UI can branch on — see the shared error shape in
  [`security.md`](security.md).
- Commands are **async by default**. Keep the body thin: parse → delegate to
  the owning module → map the error. No provider HTTP calls, parsing, or
  filesystem work inline in the command body.
- Commands live in `app/src-tauri/src/modules/**` and are only *named* in
  `lib.rs`'s `generate_handler!`; `lib.rs` itself holds no command bodies.
- Use `tauri::State<T>` for shared, mutex-guarded state (pollers, caches,
  provider clients). Never hold a `Mutex` guard across an `.await` — it
  deadlocks the async runtime.
- Long-running work belongs behind a dedicated task or plugin
  (`tauri::async_runtime::spawn`), not inside the command.
- `#[tauri::command]` functions are `pub(crate)` at most. They are an
  internal IPC surface, not a public Rust API.

## Frontend ↔ Rust boundary

- The client is **Effect-based**. `invoke` is wrapped once per command in
  `app/src/lib/ipc.ts` as an `Effect` via `Effect.tryPromise`, which also
  supplies the `AbortSignal` used to cancel on unmount. No component ever calls
  `invoke`; components read atoms. See [`effect.md`](effect.md).
- `invoke` returns `unknown` — decode it with a `Schema` before it reaches a
  component. Never cast the result to a domain type.
- Keep network-level failure (`IpcError`) and API-status failure (`UsageError`)
  as distinct types on both sides of the boundary; collapsing them makes the UI
  unable to tell "the app is offline" from "the provider said no".
- The renderer has **no ambient trust**: anything the webview can be made to
  run can call any permitted command. Capabilities are the only control, so
  treat the capability file as reviewed security surface.
- Do not pass secrets, tokens, or raw credential material across the IPC
  boundary into renderer state, atoms, or `Config` values held in the webview.
  Keep them in Rust or the OS keychain.
- The e2e harness mocks commands with `browser.tauri.mock(...)`. It patches
  `invoke` in the renderer, which is the exact seam `Effect.tryPromise` wraps, so
  command mocks still work under atoms. A command that must be mockable must
  stay a pure function of its arguments — no ambient state reads hidden behind
  it.
- Command placement follows the Rust tier rule in [`rust.md`](rust.md): commands
  live in `src/modules/**`, and `lib.rs` only names them in `generate_handler!`.

## Capabilities & permissions (least privilege)

- `app/src-tauri/capabilities/default.json` currently grants `core:default`,
  `opener:default`, `wdio:default`, `wdio-webdriver:default` to window `main`.
- **Every new permission is approval-gated.** Adding one widens what a
  compromised renderer can reach; state the capability, its risk, and why a
  narrower set will not do before editing the file.
- Never grant a wildcard (`core:allow-*`) or a whole permission set "to get it
  working". Grant the single command the feature uses.
- `wdio:default` and `wdio-webdriver:default` are **test-only**. They must stay
  behind `#[cfg(debug_assertions)]` plugin registration in `lib.rs` (they are)
  — never move them to unconditional registration, and never expose the
  embedded WebDriver in a release build.
- New capabilities get their own file with a `description` naming the feature
  that needs them; do not grow the default capability into a dumping ground.

## Security posture of the shell

- `app.security.csp` is currently `null`. Treat that as **development-only**.
  Any task that ships provider data, remote content, or user-visible release
  behaviour must set a real CSP first (`default-src 'self'` plus explicit
  allowances — no `unsafe-eval`; the client needs no remote script).
- `app.withGlobalTauri` is `true` and is **required by the e2e harness**
  (`@wdio/tauri-plugin`). Do not flip it to `false` without also accepting
  that the suite must be reworked — it is not a free hardening win here.
- Never add remote origins to `devUrl`, `frontendDist`, or capabilities to
  make something work.
- Never weaken the release profile in `app/src-tauri/Cargo.toml`
  (`lto = true`, `codegen-units = 1`, `panic = "abort"`, `strip = true`) to
  speed up a local build. Debug builds are the local-build answer.

## Platform reality

- Targets are macOS, Windows, and Linux. Linux distribution compatibility is
  **unvalidated** — never infer support for all distributions from one build.
- `main.rs` carries `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` — do not remove it (it suppresses a console window in Windows release builds).
- Paths: use `Path`/`PathBuf`, never string concatenation. `scripts/restart.ts`
  is the cross-platform reference for process and path handling.
- Process management, signals, and window behaviour differ per OS; use Tauri's
  abstractions over raw platform calls, and verify on each target OS before
  claiming a fix.
- Icons are a platform contract, not decoration: `bundle.icon` in
  `tauri.conf.json` plus the Windows `StoreLogo`/`Square*Logo` set. Regenerate
  the whole set when the brand changes — see [`logo-generation.md`](logo-generation.md).

## The e2e harness is load-bearing

`app/e2e` drives the **real compiled binary** (`src-tauri/target/debug/agentgauge`).
Five integration points must stay intact — `Cargo.toml`, `lib.rs`,
`capabilities/default.json`, `tauri.conf.json`, `src/main.tsx`. Removing any
one produces a confusing failure, not a clear error.

- Always run `bun run e2e` from `app/`; never bare `wdio` and never a bare
  `cargo build` in its place. The script owns the build so frontend and binary
  cannot drift.
- Debug the failure with the skill at `.opencode/skills/tauri-e2e-testing`
  before touching product code. If `capabilities.e2e.ts` fails, the harness is
  broken and no other result in the run can be trusted.
- Details of the build constraint, mocking, screenshots, and platform setup:
  the `tauri-e2e-testing` skill. Do not duplicate it here.

## Verification

```sh
cd app
bun run build                                          # tsc typecheck + vite build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo check  --manifest-path src-tauri/Cargo.toml
bun run e2e                                            # required for any UI change
```

Run the Rust checks for any `src-tauri` change. `bun run e2e` is **required for
any UI change** — layout, copy, state rendering, navigation, or interaction —
because a passing build cannot show that the screen renders the right thing.
There is no "small UI change" exemption; see the binding rules in the root
`AGENTS.md` and [`testing.md`](testing.md) for the full gate list and the
TDD-first workflow.
