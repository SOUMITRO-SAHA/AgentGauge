# Verified capability surface

Everything below was executed against the real binary on **macOS 15 (Darwin
24.x), Rust 1.97, Bun 1.4.2, Node 24.15**. The session identifies as
`webkit 605.1.15 macos` with user agent `AppleWebKit/605.1.15` — the native
WKWebView, not Chrome.

`app/e2e/specs/capabilities.e2e.ts` is the executable form of this document. If
the two disagree, the spec is correct.

## Screenshots — supported

| Call                                          | Result                                              |
| --------------------------------------------- | --------------------------------------------------- |
| `browser.saveScreenshot(path)`                | Writes a PNG file; **returns a Buffer**, not `true`  |
| `browser.takeScreenshot()`                    | Returns a base64 string                              |
| `element.saveScreenshot(path)`                | Works, but is **not cropped** to the element         |

Observed output for an 800x600 window on a Retina display, written to the
repo-root `.temp/e2e/`:

```
native-window.png   103,211 bytes   PNG image data, 1600 x 1200, RGBA
element-h1.png      103,211 bytes   PNG image data, 1600 x 1200, RGBA
```

The two files are **byte-identical** (same MD5). The embedded provider
captures the whole webview viewport for element screenshots too. Use full-window
captures as failure evidence; do not build pixel-diff tooling on element
crops.

Validate a capture rather than trusting the call to have succeeded:

```ts
const bytes = await browser.takeScreenshot();
expect(Buffer.from(bytes, "base64").subarray(1, 4).toString()).toBe("PNG");
```

A silent blank capture is a real risk on a headless Linux runner — assert on
byte size (`> 1000`) or the PNG magic bytes, not just that the call returned.

## `browser.tauri.*` — supported

Provided by `tauri-plugin-wdio` (Rust) plus `@wdio/tauri-plugin` (JS).

| API                                          | Verified behaviour                                    |
| -------------------------------------------- | ----------------------------------------------------- |
| `execute(({ core }) => core.invoke(cmd, args))` | Real Rust round-trip; returns the command's value  |
| `execute(fn, arg1, arg2, …)`                 | Extra arguments pass through to the script            |
| `mock(command)`                              | Direct plugin test API; supports `mockResolvedValue`, `mockImplementation`, `mockReturnValue`, `update`, `mockRestore` |
| `listWindows()`                              | `["main"]` for a single-window app                    |
| `switchWindow(label)`                        | Retargets subsequent operations                       |
| `emitEvent(name, payload, target?)`          | Declared in the type surface; not exercised here      |
| `triggerDeeplink(url)`                       | Declared in the type surface; not exercised here      |

`execute` is the important one — it is the only way to assert a command's
**return value** without a UI gesture that produces it.

`mock()` performs a full reset (history and implementation) on every call. Set
implementations in `beforeEach`; a `beforeAll` setup will be wiped by the first
test that calls `mock()` again.

### Product dispatch fixtures are page-scoped

The app's renderer sends product IPC through one `dispatch` command. Its
`Ipc.invoke` first checks the app-visible `window.__wdio_mocks__` registry, so
feature specs use `installDispatch` and `DispatchFixtures` from
`app/e2e/specs/fixtures.ts`; the `browser.tauri.mock()` API is exercised
separately by the capabilities self-test. On the current WKWebView path, the
plugin's interceptor does not replace the app-visible dispatch registry.

A navigation/remount discards the page's registry. Seed state and navigate to
the app first, wait for its mount-time read, install the dispatcher, then trigger
the view's real refresh control. `boot()` follows this order. Its default
non-onboarding fixture refreshes atoms across multiple screens; a screen-focused
spec should pass a target route and only that screen's nudges, as
`statsWithZaiAnalytics()` does for `stats/all-plans.e2e.ts`.

Dispatcher functions must be closure-free. `installDispatch` transfers fixture
values as JSON on `__ismFixtures__`; a Node-side function captured by the mock
does not survive serialization into the page.

### `window.__TAURI__.core.invoke` interception does not apply on this build

The plugin installs its interceptor with `defineProperty` on
`window.__TAURI__.core.invoke`. On this WKWebView build that patch **does not
take** — a registered mock is present in `window.__wdio_mocks__`, yet calling
through `core.invoke` returns the real response.

An app under test must therefore consult `window.__wdio_mocks__` itself before
falling back to `core.invoke`. `app/src/lib/ipc.ts` does this, with a comment
recording why.

## Spec files share one renderer

The app is a single window, so every spec file drives the *same* page. A mock
installed by one file replaces the previous file's, and running files
concurrently makes the fixtures race. Product coverage is therefore split by
feature into `app/e2e/specs/features/**/*.e2e.ts` but kept in **one ordered group**
in `wdio.conf.ts`, which wdio runs in a single worker, in order. Splitting is
safe because the group is sequential; splitting it into parallel instances is
not.

The fixtures seed both persisted stores before launch and restore their original
bytes in each feature file's file-scope `after`. Keep the spec paths in one
ordered worker group; parallel app instances would race these shared files.

## Window geometry — supported

`getWindowSize()` and `getWindowRect()` return real native window metrics, not a
browser viewport. Useful for asserting window-management changes and for
detecting a headless runner's virtual display.

## Standard element commands — supported

`getText`, `getAttribute`, `getValue`, `setValue`, `clearValue`, `click`,
`browser.keys([...])`, `waitForDisplayed`, `isDisplayed`, `isExisting`.

`browser.execute(() => …)` for direct DOM reads works as in any WebDriver
session. `getProperty` is available via `browser.getProperty()`.

## Mocking is JS-side only

`browser.tauri.mock()` tests the plugin's JavaScript interception API; it does
not replace Rust behavior. Product UI specs use the app's own page-side
`dispatch` registry instead, because the plugin interceptor and the app's
`Ipc.invoke` do not share a reliable interception path in this WKWebView build.

No `wdio:allow-set-mock` / `allow-clear-mocks` permissions exist because there
is no IPC surface to gate. `wdio:default` suffices.

## Not verified

State these as unknown rather than working:

- `emitEvent` and `triggerDeeplink` — typed and installed, never executed here.
- Backend log capture (`captureBackendLogs`) — declared, never exercised.
- Windows and Linux runs. See the platform section of `SKILL.md`.
- Multi-window scenarios — the app has a single window, so `switchWindow` is
  only exercised as a no-op round-trip.
