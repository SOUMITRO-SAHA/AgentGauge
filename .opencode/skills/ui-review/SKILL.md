---
name: UI Review
description: Visually and behaviourally review the ism desktop app UI using the WebdriverIO suite, which drives the real compiled binary in its native window. Use when asked to test, verify, smoke-test, or visually debug app UI, confirm a screen renders correctly after a change, check data/state display, dark mode, or narrow-width layout, or capture screenshots. WebdriverIO is the only test engine — there is no browser or Puppeteer target.
---

# UI Review

The `app/e2e` WebdriverIO suite is the **only** UI engine for this project. It
drives the real compiled binary (`src-tauri/target/debug/agentgauge-daemon`) through its
native webview: the Rust backend runs, IPC crosses the process boundary, and a
real OS window exists.

There is no browser target, so **Puppeteer and Playwright do not apply** — they
cannot attach to a wry/WKWebView window. Maestro is for mobile and does not
apply either. If a request implies testing this UI in "a browser", it means
running the native app.

For harness mechanics — the build constraint, the five integration points,
mocking, troubleshooting — read the **`tauri-e2e-testing`** skill. This skill
covers **what to review and how to report it**, not how the harness works.

## Review and regression coverage are different jobs

Per the root `AGENTS.md`, a UI change requires e2e coverage and TDD is the
default. This skill is for reviewing an existing screen and capturing evidence;
it is **not** a substitute for the regression spec that change must ship with.

- A change under review needs a spec in `app/e2e/specs/features/` asserting the rendered
  outcome, so the defect cannot return.
- Reviewing here — a clean report, a screenshot — catches problems in code you
  did not just touch. It does not close the requirement for the change itself.
- When the review finds a defect, fix it test-first: add the failing spec, then
  the fix.

## Setup

```sh
cd app
bun run e2e          # builds frontend + binary, then runs the suite
```

Never run bare `wdio`, and never test a stale binary. For interactive review
that needs a human-visible window:

```sh
cd app
bun run restart      # stops app-owned processes, asserts 1420/1421 free, relaunches
```

## Screenshots — free, and written straight to disk

`browser.saveScreenshot(path)` **writes the PNG file and returns a Buffer**. The
capture never round-trips through the model context, so there is no base64
dump procedure, no temp `.b64` file, and no decoding step. This is the single
biggest difference from a browser-based setup.

```ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Repo-root `.temp/screenshots`, resolved from this file so the path holds
// regardless of the working directory the runner was launched from.
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const shotDir = path.join(repoRoot, ".temp", "screenshots");
fs.mkdirSync(shotDir, { recursive: true });

const file = path.join(shotDir, "usage-live.png");
await browser.saveScreenshot(file);
expect(fs.statSync(file).size).toBeGreaterThan(1000); // blank captures are tiny
```

- **Verify the file, not the call.** Assert byte size or the PNG magic bytes
  (`subarray(1, 4).toString() === "PNG"`). A silent blank capture is a real
  risk on headless Linux runners.
- Archive review captures in the repo-root `.temp/screenshots/<screen>-<state>.png`,
  resolved from `import.meta.url` so the path holds regardless of the directory
  the runner started from. `.temp` is git-ignored — keep it that way; never
  commit captures.
- **Element screenshots are not cropped** — the embedded driver returns the full
  viewport, byte-identical to a full-window capture. Do not build element-crop
  or pixel-diff tooling on them. For a focused view, resize the app window or
  assert on DOM state instead.
- An 800×600 window captures as **1600×1200** on a Retina display (`@2x`).

## What to review

The app is a **usage and status dashboard**. A screen that renders is not
therefore correct — most real defects here are *misleading* rather than broken.

### 1. Data honesty (highest priority)

Per the root `AGENTS.md` and [`ui.md`](../../rules/ui.md):

- Every usage number, limit, and status carries its **source** and
  **last-updated time**. A number without provenance fails.
- All four states render distinctly: `live`, `cached`, `stale`, `unavailable`.
- A missing value looks unavailable — **not** `0`, not `-`, not an empty
  string, not a spinner that never resolves.
- No colour-only signalling: every status/trend has a text or `aria-label`
  equivalent.
- Nothing renders as real data when the fetch failed or the permission is
  missing.

### 2. Layout and rendering

- **Narrow width**: `body` has `min-width: 320px`; every view must hold up
  without horizontal overflow at 320px, not just at the default 800×600 window.
- **Text is never clipped or truncated silently** — a usage label cut off
  mid-number is a data-honesty bug, not a cosmetic one.
- Long provider names, long error strings, and large numbers do not break the
  layout.
- Empty/loading/error states exist for every view — no blank screens.

### 3. Interaction and accessibility

- Every interactive element is keyboard reachable with a visible focus ring.
- Status is announced, not just coloured.
- Nothing steals focus or reorders rows under the cursor during a refresh.
- `prefers-reduced-motion` is respected before adding animation.

### 4. Dark mode

Dark tokens exist in `src/index.css` under `.dark`, but **nothing toggles the
class yet**. To review dark mode, set it on `<html>` for the session, screenshot,
then remove it. Verify contrast on the muted/destructive states specifically —
they are the easiest to get wrong.

## Pass criteria

A check **PASSES** only if all hold:

1. The native window launched and the expected screen rendered (URL is
   `tauri://localhost` — if it is `http://localhost:1420`, the e2e build
   constraint was violated; see `tauri-e2e-testing`).
2. No error overlay and no uncaught renderer error.
3. Every DOM assertion returns the expected shape.
4. The screenshot file exists, is a valid PNG, and is larger than 1000 bytes.
5. The screenshot **visually** matches the reviewed state — a screenshot is
   evidence, not decoration. Inspect it before reporting.
6. Data-honesty rules in section 1 hold for the state under review.

Any mismatch is a **FAIL**.

## Not automatable — say so, don't fake it

- The **native widget** surface: outside the wry webview and outside wdio's
  reach. Manual only until it is built.
- OS-level chrome: window decorations, dock/tray behaviour, native menus,
  notification presentation.
- **Window resizing** via `setWindowSize` is **unverified** with the embedded
  driver. Confirm it works before relying on it for narrow-width review; if it
  does not, test narrow layout by setting a CSS width constraint rather than
  claiming a resized-window check.
- **Windows and Linux** runs are configured but unproven — verified on macOS
  only. Never report cross-platform coverage you did not run.

## Report format — every run ends with this

```md
UI Review — <date> — ism (<macOS | Windows | Linux>)

Scope: <screens/states reviewed>
Result: <x> passed, <y> failed, <z> warnings
Gates: bun run e2e — <pass/fail>

| Screen/State  | Check                | Result | Detail                    |
| ------------- | -------------------- | ------ | ------------------------- |
| usage-live    | provenance + time     | PASS   | "Codex · 2 min ago"        |
| usage-error   | unavailable styling   | FAIL   | renders `0%`, not a state |
| usage-narrow  | no horizontal overflow| PASS   | 320px                     |

Screenshots: .temp/screenshots/<names>
Failures: per failure — screen, expected vs observed, screenshot name
Not verified: <platforms / surfaces not covered, e.g. native widget>
```

Severity: **FAIL** = wrong or misleading data display, missing state, clipped
text, overflow, broken interaction, keyboard trap, or a blank screen. **PASS**
= renders and meets every criterion above. Anything you did not actually run is
**not verified** — say so rather than inferring it.
