# Troubleshooting

Symptom-to-cause table for the `app/e2e` suite. Ordered by how often each
actually occurs.

## `No "browserName" defined in capabilities nor hostname or port found!`

The `@wdio/tauri-service` entry was dropped from `services` in
`e2e/wdio.conf.ts`. Without the service no driver is started, so WebDriver falls
back to expecting a real browser.

`Spec Files: 0 passed, 1 failed` with this message means the service is missing,
not that the app is broken.

## `ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './api' is not defined`

`@wdio/runner@9` imports `expect-webdriverio/api`. Versions before `6.1.0` do
not export that subpath. `expect-webdriverio` is **not** a dependency of
`@wdio/runner` — it must be installed explicitly at a version exposing `./api`.

Verify before assuming:

```sh
node -p "Object.keys(require('./node_modules/expect-webdriverio/package.json').exports).join(', ')"
```

`./api` must appear in the output.

Related: `app/bunfig.toml` sets `minimumReleaseAge = 1296000` (15 days), so a
newer release can be blocked with:

```
error: No version matching "expect-webdriverio" found (blocked by minimum-release-age)
```

This is the policy working, not a registry fault. Either wait for the window to
pass or use the newest version older than 15 days. Revisit `6.1.0` periodically —
`7.0.1` and `8.0.0-alpha.3` were too new at the time of writing.

## Peer-dependency mismatch after a routine `bun install`

`@wdio/tauri-service@1.5.0` declares `webdriverio: ^9.0.0`, but the current
release line is v10. Installing `@wdio/cli@latest` pulls v10 and the suite dies
at startup. Pin the whole WDIO family to v9:

```sh
bun add -d @wdio/cli@^9 @wdio/local-runner@^9 @wdio/mocha-framework@^9 \
  @wdio/spec-reporter@^9 webdriverio@^9
```

## Suite passes but the app loaded the Vite dev server

The most dangerous failure mode, because it is green. A dev server on port 1420
serves the frontend, so tests pass in a state that will not exist in CI.

Always assert it:

```ts
expect(await browser.getUrl()).toBe("tauri://localhost");
```

If it is `http://localhost:1420`, the build constraint in `SKILL.md` was
violated — see below.

## `bun run e2e:build` did not switch the binary to the embedded frontend

`tauri-build` caches generated output, and that cache belongs to the
`tauri-build` crate. `cargo clean -p agentgauge-daemon` does not remove it, so `--features
custom-protocol` can be applied while the stale dev URL persists.

The `touch src-tauri/build.rs` in `e2e:build` is what invalidates it. If you
build by hand, reproduce the full command:

```sh
bun run build && touch src-tauri/build.rs \
  && cargo build --manifest-path src-tauri/Cargo.toml --features custom-protocol
```

**Do not verify this with `strings`.** `strings src-tauri/target/debug/agentgauge-daemon |
grep localhost:1420` reports a match whether or not that URL is used at
runtime, because `tauri.conf.json` is embedded in the binary regardless. Only
`browser.getUrl()` reflects runtime behaviour. This proxy was actively
misleading during setup.

## `Spec Files: 0 passed … No specs found to run`

The `specs` glob matched nothing. WebdriverIO resolves `specs` relative to the
**config file**, not `process.cwd()`, so `"./e2e/specs/**"` silently matches
nothing when run from `app/`. Build paths from `import.meta.url`:

```ts
const here = path.dirname(fileURLToPath(import.meta.url));
specs: [path.join(here, "specs", "**", "*.e2e.ts")],
```

The same applies to `appBinaryPath`.

## `Tauri plugin not available. Make sure @wdio/tauri-plugin is installed`

The JS side is not loaded. Confirm all four:

- `import "@wdio/tauri-plugin";` is the **first** import in `src/main.tsx`
- `app.withGlobalTauri: true` in `tauri.conf.json`
- `wdio:default` in `src-tauri/capabilities/default.json`
- the Rust plugin registered in `src-tauri/src/lib.rs`

## `window.wdioTauri is undefined`

Same root cause as above. If `import "@wdio/tauri-plugin"` is present, confirm
the test is not racing initialization — `await browser.pause(500)` is a
diagnostic, not a fix.

## Mocked command throws "unmocked Tauri command in browser mode"

The renderer invoked the command before `browser.tauri.mock(command)` was
called. Register mocks in `beforeEach`, before any code path that can trigger
the call.

## Mock returns `undefined` after `browser.url()`

A navigation wipes the renderer-side mock registry. The worker-side handle
survives, so calling `mock(command)` alone does not re-register the browser
side. Call `mock.mockRestore()` first, then `mock()` again.

## Cargo warns: `Found debug_assertions in target.'cfg(...)'.dependencies`

Cargo does not support `cfg(debug_assertions)` for dependency selection — it
warns and ignores the table. Keep the plugins in plain `[dependencies]` and gate
only the **registration** in `lib.rs`:

```rust
#[cfg(debug_assertions)]
let builder = builder
    .plugin(tauri_plugin_wdio::init())
    .plugin(tauri_plugin_wdio_webdriver::init());
```

## Screenshots are blank or missing

Assert on the result rather than the call. `saveScreenshot` returns a Buffer; a
failed capture can still be a small file. Check size and PNG magic bytes, and
check `browser.getUrl()` — a dev-server fallback often renders a different
page than the embedded bundle.

Element screenshots are never cropped; see `capabilities.md`.

If a capture lands in a system temp directory, or `.temp/e2e/` is missing after
a run, a spec is still calling `os.tmpdir()`. All artifacts belong under the
repo-root `.temp/`, resolved from `import.meta.url`.

## Linux: `webkit2gtk-driver not found` or `X11 connection refused`

Install the driver and run headless:

```sh
sudo apt-get install -y webkit2gtk-driver xvfb
xvfb-run -a bun run e2e
```

On Wayland, set `GDK_BACKEND=x11`. Unverified on this machine.

## Windows: "This version of Microsoft Edge WebDriver only supports Microsoft Edge version X"

WebView2 runtime drift. `autoDownloadEdgeDriver` defaults to `true` and should
resolve it; if it does not, pin `edgeDriverVersion` in the service options or
`EDGEDRIVER_VERSION` in the environment. Unverified on this machine.

## Tests pass individually, fail together

The embedded driver binds a fixed port (4445 by default). Two concurrent app
instances collide. `maxInstances: 1` in `e2e/wdio.conf.ts` is required and is
respected — worker IDs `[0-0]` and `[0-1]` are sequential spec indices, not
parallel workers.
