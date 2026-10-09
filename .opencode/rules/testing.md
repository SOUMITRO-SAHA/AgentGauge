# Testing & Validation Rules

There is **no CI and no pre-commit hook** in this repo. The commands below, run
locally before you finish, are the gate. There is also **no client unit-test
runner** yet — the automated surface is the WebdriverIO e2e suite plus the
Rust/TypeScript compilers. Adding Vitest/Jest is a dependency addition and
therefore approval-gated (see [`dependency-updates.md`](dependency-updates.md)).

## Definition of done

Run the checks for **what you touched**:

| Change                                              | Required commands (from `app/`)                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any client change (`app/src/**`, config)             | `bun run build` (tsc + vite), `bun run e2e`                                                                                                       |
| IPC command, capability, plugin, or `src-tauri`      | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` · `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` · `cargo check --manifest-path src-tauri/Cargo.toml` · `bun run build` · `bun run e2e` |
| Pure Rust logic worth isolating                       | the same Rust gates + an inline `#[cfg(test)]` unit test                                                                                            |
| UI, copy, or data-display change                      | `bun run e2e` (assert the rendered state, not just that it compiles)                                                                                |
| `tauri.conf.json`, icons, bundle, or release profile  | `bun run tauri build` on the target OS, plus the Rust gates                                                                                        |
| `website/` (once initialised)                         | its own Astro build — it is **not** part of the app build                                                                                           |

Never finish with a compiler warning, a clippy warning, or a skipped e2e run
"because it was only a small change".

## Test-first development (binding)

TDD is the default for **every** change — UI, IPC, provider modules, and pure
helpers alike. The word "prefer" is not an escape hatch: the only reasons to
write code first are a genuinely unknown API or a spike that will be deleted.

- Start every behaviour change and bug fix with the smallest focused test that
  demonstrates the desired contract or regression. Confirm it fails for the
  intended reason **before** implementing, then make it pass with the smallest
  production change, then refactor while green.
- Test observable behaviour and public contracts, not private implementation.
  For this app that means the rendered usage/status state, the IPC payload
  shape, and the Rust command's returned value.
- Refactors preserve or improve coverage. When extracting a module, move its
  tests and add direct tests for newly public pure helpers and every meaningful
  success, validation, and error branch.
- No feature, defect fix, or security fix is complete without coverage. If
  automation is genuinely impossible (e.g. a native-widget surface wdio cannot
  reach), document the exact manual verification and why in your summary.

## UI changes require e2e coverage (binding)

A change to anything the user sees or does — layout, copy, state rendering,
navigation, interaction, or data display — is **not complete** until an e2e
spec asserts the rendered result and `bun run e2e` has actually been run green.

- The spec asserts the **outcome**, not the mechanics: that the screen shows the
  right state, not that the component compiled or that a class name is present.
- Type-checking, linting, and a passing build are **not** coverage for a UI
  change. They cannot catch a wrong number, a missing empty state, a clipped
  label, or an unreachable control.
- "It was only a small change", "it is styling only", and "the logic did not
  change" are not exemptions. Styling changes are the ones that break data
  honesty silently.
- The run must really have happened. Report the actual result — a green claim
  from an unrun command is worse than an admitted gap.

For review-and-capture workflows rather than regression coverage, use the
`ui-review` skill; it drives the same suite.

## Writing e2e specs

Specs live in `app/e2e/specs/*.e2e.ts` and drive the **real compiled binary**
through the native webview — the Rust backend runs, IPC crosses the process
boundary, and the OS window exists.

- Read the `tauri-e2e-testing` skill (`.opencode/skills/tauri-e2e-testing`)
  before extending the suite; it holds the build constraint, mocking, and
  screenshot API details. `app/e2e/specs/app.e2e.ts` is the pattern to follow.
- `capabilities.e2e.ts` is a **harness self-test**, not product coverage. If it
  fails, the harness is broken and no other result in that run is trusted.
- Always invoke via `bun run e2e` (it owns the build). Never bare `wdio`, never
  a bare `cargo build` — see the `custom-protocol` + `touch build.rs` constraint
  in [`tauri.md`](tauri.md).
- Mock a Rust command with `browser.tauri.mock(...)` to isolate the renderer,
  then assert on recorded args via `mock.update()`. `mock()` fully resets on
  every call — set implementations in `beforeEach`, never `beforeAll`, and
  always `mockRestore()`.
- Reach the Rust side with `browser.tauri.execute(({ core }) => core.invoke(...))`
  when no UI gesture triggers the command; prefer a real UI gesture when the
  point of the test is that the gesture produces the call.
- Screenshot on failure with `browser.saveScreenshot(file)` — it returns a
  `Buffer`, not `true`.
- `maxInstances: 1` is required; the embedded driver binds a fixed port.

## Rust tests

- Unit tests inline under `#[cfg(test)] mod tests` in the module they cover;
  integration tests in `app/src-tauri/tests/`.
- Cover the error branches, not just the happy path. Use temp fixtures; never
  touch the developer's real data or repo state.
- Time-dependent logic must be deterministic in tests: inject a clock rather
  than calling `SystemTime::now()` in the code under test.
- Run the suite with `cargo test --manifest-path app/src-tauri/Cargo.toml`.

## Test environment

- Tests never require network access, real API keys, or live provider
  accounts. Provider responses are faked at the HTTP/IPC boundary.
- Never run a test or one-off command against a real provider account in a way
  that could mutate it. Read-only, mocked, or explicitly-approved only.
- Do not hardcode real tokens, cookies, or account identifiers in fixtures,
  mocks, snapshots, or test files.
- Screenshots and e2e artifacts go to the **repo-root `.temp/`**, resolved from
  `import.meta.url` so the location holds regardless of the directory the
  runner started from — never `os.tmpdir()`, which scatters output across a
  per-machine path. `.temp` is git-ignored, so artifacts stay local; never
  commit them.
- Polling, timers, and relative-time rendering need an injected/fixed clock so
  assertions are not flaky.

## Platform caveat

The e2e suite is **verified on macOS only**; Windows and Linux are configured
but unproven (see the skill). Never claim cross-platform verification you did
not perform. A green run on one OS is not evidence for another, and one Linux
distribution is not evidence for all of them.