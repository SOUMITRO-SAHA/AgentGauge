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
| `mock(command)`                              | Intercepts `invoke`; supports `mockResolvedValue`, `mockImplementation`, `mockReturnValue`, `update`, `mockRestore` |
| `listWindows()`                              | `["main"]` for a single-window app                    |
| `switchWindow(label)`                        | Retargets subsequent operations                       |
| `emitEvent(name, payload, target?)`          | Declared in the type surface; not exercised here      |
| `triggerDeeplink(url)`                       | Declared in the type surface; not exercised here      |

`execute` is the important one — it is the only way to assert a command's
**return value** without a UI gesture that produces it.

`mock()` performs a full reset (history and implementation) on every call. Set
implementations in `beforeEach`; a `beforeAll` setup will be wiped by the first
test that calls `mock()` again.

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

`mock()` patches `window.__TAURI_INTERNALS__.invoke` in the renderer. It
intercepts the frontend's call before it reaches Rust — the real command still
exists and still runs if invoked from anywhere else. Mocking is therefore a
renderer-isolation tool, not a backend sandbox.

No `wdio:allow-set-mock` / `allow-clear-mocks` permissions exist because there
is no IPC surface to gate. `wdio:default` suffices.

## Not verified

State these as unknown rather than working:

- `emitEvent` and `triggerDeeplink` — typed and installed, never executed here.
- Backend log capture (`captureBackendLogs`) — declared, never exercised.
- Windows and Linux runs. See the platform section of `SKILL.md`.
- Multi-window scenarios — the app has a single window, so `switchWindow` is
  only exercised as a no-op round-trip.