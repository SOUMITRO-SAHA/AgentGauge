# Agent guidance

<critical_rules>

## Multi-agent task registry (mandatory)

> **Standalone mode:** If the user mentions "standalone mode" at the start of a
> session, skip everything in this section entirely and work without the task
> registry.

Multiple coding agents may work in this repo at the same time. All work is
coordinated through one registry at `.agents/tasks/` — no off-registry tasks.
Most of `.agents/tasks/` is git-ignored and local to the clone — **except**
`.agents/tasks/research/`, which is committed so findings persist across clones.

### Every session, in order

1. Read `.agents/tasks/TODO.md` — the single entry point for all work.
2. Sweep: move any finished task folders from `.agents/tasks/planning/` to
   `.agents/tasks/completed/` and update `.agents/tasks/TODO.md` (remove from Active, append
   to Recently completed).
3. Claim before you code: append a row to the Active table using the next free
   `task_id`. Never stage or commit it.

### Task lifecycle

CLAIMED → RUNNING/BLOCKED → DONE/CANCELLED
.agents/tasks/TODO.md .agents/tasks/planning/<id>/ .agents/tasks/completed/<id>/

- `.agents/tasks/planning/<task_id>/` holds ONLY running (and blocked) tasks — exactly
  two files: `<task_id>.plan.md` (durable rationale) and `<task_id>.todo.md`
  (live checklist, updated as you work).
- On completion or cancellation, move the entire folder to
  `.agents/tasks/completed/<task_id>/` and update `.agents/tasks/TODO.md`. Never leave a
  finished task in `planning/`.
- Invariant: `ls .agents/tasks/planning` must exactly match the Active table in
  `.agents/tasks/TODO.md`.

### Key format

`<agent-id>-<YYYYMMDDTHHMMSSZ>-<task_id>` — e.g.
`codex-20260115T093000Z-auth-api`. `<agent-id>` is a short session handle,
datetime is UTC (`date -u +%Y%m%dT%H%M%SZ`), `<task_id>` is a short
kebab-case handle and is the folder name.

### Durable memory — `.agents/contexts/`

- Before starting: read `.agents/contexts/overview.md` (the task → context
  mapping table) and any context files mapped to your task.
- After finishing: write what was done, key decisions, patterns used, and file
  locations to `.agents/contexts/<task_name>.md`, and add the row to
  `overview.md`. This is the project's long-term memory — future agents resume
  from these files, not from chat history.
- Keep one authoritative file per subject; extend an existing file instead of
  creating a parallel one.

### Research tasks

If a task is primarily research (spike, investigation, literature review, library evaluation, etc.):

- Follow the normal task lifecycle (claim, plan, complete).
- Write a detailed findings document at
  `.agents/tasks/research/<research_task_name>.md`. Include: goal, sources consulted, key findings, options considered, recommendation, and any open questions.
- **This file is committed** — it is the permanent record for the team.
  Stage and commit it when the task is done.
- The corresponding `planning/<task_id>/` folder is still ignored and should be moved to `completed/` as usual.

### Git rules

- Never stage, add, or commit anything under `.agents/tasks/` **except**
  `.agents/tasks/research/` (research findings are intentionally committed).

</critical_rules>

## Project intent

This is an early-stage Tauri 2 desktop app and native-widget project named **AgentGauge**, for AI coding-harness usage and status. The primary platform goals are macOS, Windows, and Linux.

The current UI and Rust backend implement **Codex only**: real usage reads via `codex app-server`, rollover detection, onboarding, the dashboard, and a frameless desktop widget. The app's executable is `agentgauge-daemon`; the polling backend runs inside that same desktop process and is not a separately installed service. Do not describe other harnesses as integrated unless the code actually implements them, and do not claim Windows or Linux verification — only macOS has been exercised.

## A 5-hour window cannot be restarted by a prompt

`resetsAt` is computed by the Codex provider and is only ever read, never derived, anywhere in the upstream codebase. Sending a prompt **consumes** the current window rather than opening a fresh one. The app detects a rollover by comparing `resetsAt` across polls; it never manufactures one. Do not add or describe a "roll the window" action that implies otherwise.

`sendPing` spends the account's quota. Nothing may call it on a timer the user did not explicitly opt into.

## The widget is a system widget, not a window

Do not reintroduce a floating or always-on-top window for the widget. On macOS the
mechanism is a WidgetKit app extension in `app/src-tauri/widget/`, embedded at
`Contents/PlugIns/`, which the user places from the system widget gallery. Three
things make this fragile and each has bitten already — see
`app/src-tauri/widget/README.md` before changing any of it:

- It **must** be built from a real Xcode app-extension target. A SwiftPM executable
  wrapped in an `.appex` registers and then exits immediately on macOS 26+.
- `NSExtensionPrincipalClass` must not be set, and `CFBundlePackageType` must be
  `XPC!`. `build-widget.sh` enforces both.
- macOS has **no** `accessory*` widget families; they are iOS/watchOS only. Use
  `systemSmall` / `systemMedium` / `systemLarge`.

The app must never imply it installed the widget. macOS exposes no API for a host
app to add one or to ask whether the user placed it, so `SystemWidgetStatus` only
ever reports facts about the build.

The widget and the app are separate processes and share data through a JSON
snapshot written atomically to the legacy-compatible path
`~/Library/Application Support/AI Sub Stats/`. The
window list carries an explicit `kind`, never a label the Swift side has to
pattern-match on.

## Project structure and conventions

- `app/`: Tauri desktop application; keep all Tauri configuration and code here.
- `app/src/`: React and TypeScript client.
- `app/src/components/ui/`: shadcn/ui components.
- `app/src/lib/utils.ts`: shared `cn()` class-name utility.
- `app/src-tauri/`: Tauri configuration and Rust backend.
- `app/src-tauri/src/modules/`: Rust application modules, one per bounded capability (provider integrations, polling, settings, widget).
- `app/src-tauri/src/shared/`: Rust primitives shared by 2+ modules (domain types, error taxonomy, config, telemetry). Must not depend on `modules/`.
- `app/src-tauri/crates/`: new independent Rust library crates, one bounded concern each, consumed as path dependencies.
- Rust dependencies flow downward only: `lib.rs` (composition root) → `modules` → `shared` → `crates`. No cycles, no sideways imports between sibling modules.
- `website/`: reserved for a future Astro landing page and documentation site. Do not add it to the app build.
- Use the `~/` alias for imports from `app/src` (for example, `~/lib/utils`). Keep it aligned in `app/vite.config.ts`, `app/tsconfig.json`, and `app/components.json`.
- Styling uses Tailwind CSS 4 through `@tailwindcss/vite`; do not add a Tailwind 3 config unless the project is deliberately migrated.
- **shadcn-first, strictly.** If a component exists in the shadcn registry, it
  must be used — research it with the shadcn MCP and install it with the
  shadcn CLI; never hand-roll an equivalent. Custom components are the
  exception: only when the registry genuinely lacks the primitive, built on
  top of the vendored primitives and theme tokens, with the reason stated.
  The visual language is fixed, not per-screen taste: theme tokens from
  `app/src/index.css` only (no raw palette colours), 4px-grid spacing, macOS
  standard border radius from the `--radius` scale (`rounded-lg` panels,
  `rounded-md` controls, `rounded-xl` floating overlays), and the glossy
  macOS material — `glass` for chrome, the shared `PANEL` treatment for
  content. Full rules: [`ui.md`](.opencode/rules/ui.md).
- Follow the surrounding TypeScript/React and Rust style. Keep provider-specific code modular rather than coupling provider behavior into general UI components.
- Place Rust code in the tier that owns it: a single caller's helper stays private in its module, 2+ consumers' primitives go in `src/shared/`, and reusable or dependency-heavy logic becomes a crate under `app/src-tauri/crates/`. Full architecture rules: [`rust.md`](.opencode/rules/rust.md).
- Keep `app/bun.lock` and `app/src-tauri/Cargo.lock` in sync with dependency changes.

## Development and verification

Use Bun for JavaScript package operations:

```sh
cd app
bun install
bun run build
bun run tauri dev
```

For native Rust changes, also run relevant Rust checks, such as:

```sh
cargo fmt --manifest-path app/src-tauri/Cargo.toml -- --check
cargo check --manifest-path app/src-tauri/Cargo.toml
```

Builds and runtime behavior are platform-specific. Validate changes on macOS, Windows, and Linux as applicable; do not infer support for all Linux distributions from a build on just one distribution.

## Testing policy

Two rules are binding on every change, with no exceptions for small or low-risk edits.

**Prefer TDD for everything.** Start from the smallest focused test that states the desired behaviour or reproduces the defect. Confirm it fails for the intended reason, then make it pass with the smallest production change, then refactor while it stays green. This applies to UI work, IPC commands, provider modules, and pure helpers alike — not only to "testable" logic.

**A UI change requires e2e coverage.** Any change to what the user sees or does — layout, copy, state rendering, navigation, interaction, or data display — ships with an e2e spec in `app/e2e/specs/` asserting the rendered result, not merely that it compiles. Asserting that the change type-checks is not coverage. A UI change without a passing e2e run is unfinished, and the run must actually have been executed:

```sh
cd app
bun run e2e
```

`bun run e2e` builds the frontend and the binary and then drives the real compiled app through its native webview, so it covers both the renderer and the Rust side. Use it rather than bare `wdio` or a bare `cargo build`. If a surface genuinely cannot be automated (for example the native widget, which is outside the webview), document the exact manual verification and the reason in your summary rather than silently omitting it.

Gates by change type, and the harness mechanics — build constraint, mocking, screenshots, troubleshooting — are in [`testing.md`](.opencode/rules/testing.md) and the `tauri-e2e-testing` skill.

## Provider data and security

- Use documented, authorized provider interfaces and respect provider terms and rate limits.
- Clearly distinguish live, cached, stale, and unavailable data; expose provenance and update time where appropriate.
- Handle provider failures and missing permissions without presenting fabricated values as real status or usage.
- Never commit API keys, session tokens, personal account data, or local environment files. Do not log secrets.
- Prefer secure OS credential storage for future secrets; do not store credentials in frontend source, plain-text config, or the repository.
- Keep automation explicit, understandable, and under the user's control; avoid surprising or destructive account actions.

## Repository hygiene

- Preserve the root and `app/src-tauri` ignore rules; do not add build output, dependency directories, generated Tauri schemas, or local secrets to commits.
- Avoid unrelated changes and do not overwrite existing user work.
- Update the README when project setup, supported behavior, or platform requirements materially change.
