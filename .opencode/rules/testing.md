# Testing & Validation Rules

**`AGENTS.md` § Testing policy is binding and this file does not weaken it.**
Two rules apply to every change, with no exceptions for small or low-risk edits:

1. **Prefer TDD for everything** — smallest focused test first, confirm it fails
   for the intended reason, smallest production change, refactor while green.
   This covers UI work, IPC commands, provider modules, and pure helpers.
2. **A UI change requires e2e coverage** — an e2e spec asserting the *rendered
   result*, and that spec must actually have been run
   (`bun run e2e --spec ./e2e/specs/<task>.e2e.ts`). Type-checking is not
   coverage. Per task, run only the spec(s) tied to that task's change — the
   full suite is not required.

There is no CI and no pre-commit hook. The commands below, run locally, are the
gate.

## Definition of done

| Change | Required (from `app/`) |
| --- | --- |
| Any client change | `bun run build` · `bun run test` · `bun run e2e --spec <task spec>` |
| Effect code (atoms, services, layers) | `bun run build` · `bun run test` (vitest + `@effect/vitest`) · `bun run e2e --spec <task spec>` |
| UI change (layout, copy, state, navigation, data display) | all of the above, **plus a new/updated spec in `app/e2e/specs/features/`** |
| IPC command / capability / plugin / `src-tauri` | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` · `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` · `cargo check --manifest-path src-tauri/Cargo.toml` · `bun run build` · `bun run test` · `bun run e2e --spec <task spec>` |
| New Rust module or crate | the Rust gates · `cargo test --manifest-path src-tauri/Cargo.toml` (`cargo test -p <crate>` for a crate) |
| `tauri.conf.json`, icons, bundle, release profile | the Rust gates · `bun run tauri build` on the target OS · `bun run e2e --spec <task spec>` |
| `website/` (once initialised) | its own Astro build — not part of the app build |

`<task spec>` is the spec file covering the task's change (several may be
listed). Only a change that cuts across the suite — boot, fixtures, harness —
needs the full `bun run e2e`.

Never finish with a compiler warning, a clippy warning, an unrun e2e suite, or a
claim that a gate passed without having run it.

## Test-first development

- Start from the smallest focused test that states the desired behaviour or
  reproduces the defect. Confirm it fails **for the intended reason** before
  implementing.
- Test observable behaviour and public contracts, not private implementation.
  For this app that means rendered state, the IPC payload shape, the atom's
  `AsyncResult` transitions, and the Rust command's returned value.
- Refactors preserve or improve coverage. When extracting a module, move its
  tests and add direct tests for newly public pure helpers and every meaningful
  success, validation, and error branch.
- No feature, defect fix, or security fix is complete without coverage. If
  automation is genuinely impossible (the native widget is outside the webview),
  **document the exact manual verification and the reason in your summary** —
  do not silently omit it.

## Test layers

Three layers, each with a job. Pick the cheapest that proves the thing.

1. **Pure/unit** — `bun run test`. Pure functions, Schema decoders, domain
   state transitions, atoms, services. Fast, no browser.
2. **Component** — `bun run test`. jsdom + `@testing-library/react`, rendering
   inside `RegistryProvider`. Proves a component renders each `AsyncResult`
   branch correctly.
3. **e2e/native** — `bun run e2e`. The real compiled binary in its native
   window. Proves the renderer, IPC, and Rust work together, and is the **only**
   gate for anything a user sees or does.

## Effect tests

- `it.effect` for anything with time or resources — it provides a virtual
  `TestClock` and an ambient `Scope`. `it.live` only when real time is genuinely
  required.
- **Use `assert` from `@effect/vitest`, not `expect`.** That is Effect's house
  rule and keeps assertion failures typed.
- **Never `Effect.runSync` in tests.** Assert failure as data:
  `Effect.runPromise(program.pipe(Effect.result))` compared to `Result.succeed` /
  `Result.fail`.
- Time must be injected — use `Clock`/`TestClock`, never `Date.now()`. A test
  that depends on wall-clock time is flaky.
- Provide stubs with `it.layer(...)` or
  `Effect.provide(program, Layer.succeed(Svc, stub))`;
  `Layer.mock(Svc, partial)` for partial fakes.
- Test that failure paths produce the right **`AsyncResult`** variant, not just
  that an error was thrown.

### Atoms & React

- Render inside `RegistryProvider`. Without it the hooks fall back to a
  module-level shared registry and tests leak state into each other.
- Swap implementations by seeding the runtime layer:
  `initialValues={[Atom.initialValue(runtime.layer, TestLayer)]}` — the
  supported way to test a component without Rust.
- `useAtomValue` accepts a selector (`useAtomValue(atom, AsyncResult.getOrThrow)`);
  prefer a selector over deriving in the component body.
- jsdom + `@testing-library/react` covers renderer logic. It does **not** cover
  the native window, plugins, or real IPC — that is what `bun run e2e` is for.

## Rust tests

- Unit tests inline under `#[cfg(test)] mod tests` in the module they cover;
  integration tests in `app/src-tauri/tests/`.
- A crate under `app/src-tauri/crates/` must pass `cargo test -p <crate>`
  **standalone**, with no Tauri app in the picture. If a test needs the app, the
  code belongs in a module, not a crate.
- Cover error branches, not just the happy path. Use temp fixtures; never touch
  the developer's real data or repo state.
- `cargo test --manifest-path app/src-tauri/Cargo.toml`.

## Writing e2e specs

Specs live in `app/e2e/specs/features/*.e2e.ts` and drive the **real compiled
binary** through its native webview.

- Read the `tauri-e2e-testing` skill before extending the suite; it holds the
  build constraint, mocking, and screenshot details.
  `specs/features/dashboard.e2e.ts` is the pattern.
- **One targeted spec per feature, kept small.** Feature coverage lives under
  `app/e2e/specs/features/`, one file per feature or surface, covering only
  that feature: a small feature gets a small spec. Every file boots the real
  binary, so spec count is suite cost — never grow an existing file with
  unrelated coverage and never assert one feature inside another feature's
  spec. A new concern gets its own file.
- **Sub-folders under `features/` group related specs.** Once a surface
  accumulates several specs, move them into a sub-folder (e.g.
  `features/onboarding/`) rather than flattening ever more files into
  `features/`; keep the files registered under their new paths.
- Every feature file is listed in the **single ordered group** in
  `wdio.conf.ts` — the group is what keeps them sequential in one worker.
  Adding or moving a feature file means updating that group's paths, never
  globbing: a glob runs files as parallel instances and the fixtures race.
- Run only the spec(s) the task touched, **one `--spec` value per
  invocation** — multiple `--spec` flags run wdio files as racing parallel
  instances. The full `bun run e2e` is for changes that cut across the suite
  (boot, fixtures, harness, config) and for harness-level edits.
- `capabilities.e2e.ts` is a **harness self-test**. If it fails, the harness is
  broken and no other result in that run can be trusted.
- Always go through `bun run e2e` (it owns the build); `--spec` filtering still
  counts — the point is the build step, not the suite scope. Never bare `wdio`,
  never a bare `cargo build` — see the `custom-protocol` + `touch build.rs`
  constraint in [`tauri.md`](tauri.md).
- Assert the **rendered result**: the element, its text, and the state it is in.
  A spec that only proves the app compiled is not coverage.
- Mock a Rust command with `browser.tauri.mock(...)` to drive renderer states
  (live, cached, stale, unavailable) deterministically. `mock()` fully resets on
  every call — set implementations in `beforeEach`, always `mockRestore()`.
- Reach the Rust side with
  `browser.tauri.execute(({ core }) => core.invoke(...))` when no UI gesture
  triggers the command; prefer a real gesture when the gesture producing the call
  is the point of the test.
- `browser.saveScreenshot(file)` returns a Buffer and writes the PNG — verify
  byte size, do not trust the call. See the `ui-review` skill.
- `maxInstances: 1` is required; the embedded driver binds a fixed port.

## Test environment

- No test may require network access, real API keys, or a live provider account.
  Provider responses are faked at the IPC or HTTP boundary.
- Never run anything against a real provider account in a way that could mutate
  it. Read-only, mocked, or explicitly approved only.
- Do not hardcode real tokens, cookies, or account identifiers in fixtures,
  mocks, snapshots, or test files.
- Screenshots and e2e artifacts go to the **repo-root `.temp/`**, resolved from
  `import.meta.url` so the path holds regardless of the directory the runner
  started from — never `os.tmpdir()`, which scatters output across a per-machine
  path. `.temp` is git-ignored; never commit artifacts.
- Polling, timers, and relative-time rendering need an injected or fixed clock.

## Platform caveat

The e2e suite is **verified on macOS only**; Windows and Linux are configured but
unproven. Never claim cross-platform verification you did not perform, and never
infer support for all Linux distributions from one.