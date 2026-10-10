---
name: Tauri E2E Testing
description: Run, repair, and extend the WebdriverIO end-to-end suite that drives the real ism desktop binary on macOS, Windows, and Linux. Use when adding UI/navigation tests, when `bun run e2e` fails, when a change touches src-tauri capabilities or plugins, or when a screenshot, Rust command mock, or window assertion is needed.
---

# Tauri E2E Testing

`app/e2e` drives the **real compiled Tauri binary** (`src-tauri/target/debug/agentgauge-daemon`)
through its native webview. It is not a browser test: the Rust backend runs, IPC
crosses the process boundary, and the OS window exists.

```sh
cd app
bun run e2e          # build frontend + binary, then run the suite
bun run e2e:build    # build only (no test run)
```

Do not run `wdio` against a Vite dev server or a stale binary. `bun run e2e`
owns the build so the frontend and binary can never drift apart.

## Why this is load-bearing

Per the root `AGENTS.md` and `.opencode/rules/testing.md`, **a UI change
requires e2e coverage** and TDD is the default for every change. A passing
build cannot show that a screen renders the right thing, so this suite — not
`tsc`, not clippy — is what proves a UI change works. "It was only a small
change" and "it was styling only" are not exemptions; styling changes are
exactly the ones that break data honesty silently.

## Before changing anything

`e2e/specs/capabilities.e2e.ts` is a harness self-test, not product coverage.
It asserts that screenshots, the plugin bridge, mocking, and window APIs work
in this environment. **If it fails, the harness is broken — not the app.** Fix it
before trusting any product test result. Read `references/capabilities.md` for
what it covers and the limitations it documents.

## The five integration points

The harness depends on all five. Removing any one produces a confusing failure
rather than a clear error.

| Surface                            | Requirement                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `src-tauri/Cargo.toml`             | `tauri-plugin-wdio`, `tauri-plugin-wdio-webdriver`, `custom-protocol` feature |
| `src-tauri/src/lib.rs`             | both plugins registered under `#[cfg(debug_assertions)]`                       |
| `src-tauri/capabilities/default.json` | `wdio:default` + `wdio-webdriver:default`                                  |
| `src-tauri/tauri.conf.json`        | `app.withGlobalTauri: true`                                                   |
| `src/main.tsx`                     | `import "@wdio/tauri-plugin";` as the first import                            |

`driverProvider: "embedded"` in `e2e/wdio.conf.ts` is what makes macOS work: it
runs the WebDriver server **inside** the app, so no external driver binary and
no paid CrabNebula key are needed. Changing it to `external` will fail on macOS
because Apple ships no WebDriver for WKWebView.

## Non-negotiable build constraint

The binary must be built with `--features custom-protocol` **and**
`src-tauri/build.rs` touched, or it silently loads `http://localhost:1420`
instead of the embedded bundle:

```sh
bun run build && touch src-tauri/build.rs \
  && cargo build --manifest-path src-tauri/Cargo.toml --features custom-protocol
```

Two independent facts collide here:

- A **debug** build keeps `#[cfg(debug_assertions)]`, so the wdio plugins
  register — but debug builds always serve `devUrl`, requiring a live Vite
  server.
- A **release** build embeds `frontendDist`, but strips `debug_assertions`, so
  the plugins vanish.

`custom-protocol` resolves it: a debug build that serves the embedded bundle.

`tauri-build` caches its generated output, and that cache belongs to the
`tauri-build` crate — `cargo clean -p agentgauge-daemon` does **not** clear it. Without the
`touch`, a rebuild reuses the stale dev URL and the suite passes against a
running dev server while appearing green. `bun run e2e:build` performs the
`touch`; never run the bare `cargo build` in its place.

## Debugging a failure

Check these in order — the first three account for nearly every failure.

1. **Is it the harness?** Run `bun run e2e`. If `capabilities.e2e.ts` fails,
   trust nothing else in the run.
2. **Did it load the right frontend?** `browser.getUrl()` must be
   `tauri://localhost`. If it is `http://localhost:1420`, the build constraint
   above was violated.
3. **Dependency versions.** `@wdio/tauri-service@1.5.0` peers on
   `webdriverio@^9` while v10 is current; a v10 install breaks at
   `expect-webdriverio/api`. `expect-webdriverio` must be a version exporting
   the `./api` subpath — currently pinned to `6.1.0` because `bunfig.toml` sets
   `minimumReleaseAge` and newer versions were not yet installable.
4. **Session creation errors** (`No "browserName" defined`) mean the
   `@wdio/tauri-service` entry was dropped from `services`.
5. **`Spec Files: 0 passed`** means the `specs` glob matched nothing. Paths are
   resolved relative to the config file, so they must be built from
   `import.meta.url`, never from `process.cwd()`.

`references/troubleshooting.md` lists the full symptom-to-cause table.

## Writing tests

Specs live in `app/e2e/specs/features/*.e2e.ts`, one file per feature, and
drive the real binary. Follow `e2e/specs/features/dashboard.e2e.ts`.

```ts
import { expect, browser, $ } from "@wdio/globals";
```

- Assert renderer state with element commands (`getText`, `isDisplayed`,
  `getValue`, `getAttribute`).
- Reach the Rust side with `browser.tauri.execute(({ core }) => core.invoke(...))`
  when no UI gesture triggers the command; use UI gestures when the point of the
  test is that the gesture produces the call.
- Mock a command to isolate the renderer, then assert on recorded arguments:

  ```ts
  const mock = await browser.tauri.mock("get_usage");
  await mock.mockResolvedValue({ remaining: 42 });
  // ...trigger via UI...
  await mock.update();
  expect(mock.mock.calls[0]).toEqual([{ range: "week" }]);
  await mock.mockRestore();
  ```

  `mock()` fully resets on every call, so set implementations in `beforeEach`,
  never `beforeAll`.
- Screenshot on failure with `browser.saveScreenshot(file)`. It returns a
  Buffer, not `true`. **Element screenshots are not cropped** — they return the
  full viewport. See `references/capabilities.md`.
- Write all artifacts — screenshots, dumps, scratch files — to the repo-root
  `.temp/` directory, never to `os.tmpdir()`. `.temp` is git-ignored, so
  artifacts cannot leak into a commit, and they sit next to the run output
  instead of a per-machine system path. `.temp/e2e/` is the screenshot
  destination; resolve it from `import.meta.url` so it holds regardless of the
  directory the runner was launched from.
- `maxInstances: 1` is required. Worker IDs read `[0-0]`, `[0-1]` — the second
  index is the spec file, not a second worker; the embedded driver binds a
  fixed port and concurrent app instances collide.

## Platform coverage

Verified on **macOS only**. Windows and Linux are configured but unproven — say
so rather than implying coverage.

- **Windows** — `msedgedriver` is auto-downloaded to match the bundled
  WebView2. A version mismatch surfaces as "This version of Microsoft Edge
  WebDriver only supports Microsoft Edge version X"; `autoDownloadEdgeDriver`
  defaults to true.
- **Linux** — install `webkit2gtk-driver` (`apt-get install -y
  webkit2gtk-driver`, or `dnf`/`pacman` equivalents) and run headless via
  `xvfb-run -a bun run e2e`. WebdriverIO 9.19.1+ auto-detects Xvfb.
  Alpine and CentOS Stream/RHEL cannot build Tauri at all.
- **macOS** — nothing to install; `embedded` is auto-detected.

## Scope

Keep provider integrations, monitoring, and widget behavior out of this skill.
It covers the test harness only; per the root `AGENTS.md`, do not describe
unimplemented features as working.

## Related

- `references/capabilities.md` — verified API surface, screenshots, limitations
- `references/troubleshooting.md` — symptom-to-cause table
