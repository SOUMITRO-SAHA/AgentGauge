# AI Subscription Stats

A cross-platform desktop app and native-widget project for keeping track of AI subscriptions, usage statistics, service status, and related automations in one place.

The goal is to support subscriptions and tools such as OpenAI Codex, Claude Code, and Z.ai, with an architecture that can grow to include other AI providers. The primary desktop targets are macOS, Windows, and Linux, with Linux distribution compatibility to be validated as the app develops.

> **Project status:** Working prototype. Codex is integrated: the app reads your
> real 5-hour and weekly usage windows from the Codex CLI, watches for a window
> rollover, and ships a desktop widget. Other providers (Z.ai, Claude Code) are
> designed for but **not yet implemented**.

## Project goals

- Show a useful overview of AI subscription accounts, usage, limits, and renewal information.
- Surface provider and service availability with clear source and freshness information.
- Support practical automations around monitoring and subscription workflows.
- Provide a compact native-widget experience alongside the full desktop app.
- Keep provider integrations modular so additional services can be added over time.
- Run on macOS, Windows, and Linux; validate packaging and behavior on each supported platform.

Provider names above describe intended coverage, not a claim of an existing integration. Available data and automation will depend on each provider's supported APIs, local tools, and terms.

## Repository layout

```text
app/       Tauri desktop application (React client and Rust backend)
website/   Reserved for a future Astro landing page and documentation site
```

The website is intentionally an uninitialized placeholder. It is separate from the desktop app and is not included in the app's build. All Tauri configuration and code lives under `app/`.

## Technology

- [Tauri 2](https://v2.tauri.app/) for the native desktop shell and Rust backend
- React 19 and TypeScript for the client
- [Effect](https://effect.website) 4 (beta) for state, async work, and Schema
  decoding of every IPC payload
- Vite 8 for development and production builds
- Tailwind CSS 4 and shadcn/ui for styling and UI components
- Bun for JavaScript dependencies and scripts
- vitest for unit and component tests; WebdriverIO for end-to-end tests

## Architecture

The renderer and Rust speak **one** protocol: a tagged `AppRequest` in, a tagged
`AppResponse` out, behind a single `dispatch` command. Both enums are
exhaustive, so adding a capability is one variant rather than a new
stringly-typed command name.

```
app/src/
  lib/ipc.ts          # the ONLY place invoke() is called; Schema decodes every payload
  lib/usage.ts        # pure display rules (freshness, tone, countdown)
  atoms/              # every value the app renders
  components/         # onboarding, dashboard, usage, widget

app/src-tauri/src/
  shared/protocol.rs  # the request/response contract
  shared/domain.rs    # provider-agnostic types carrying provenance
  modules/            # providers, automation, widget, onboarding, commands
  crates/             # (empty — no external crates are used yet)
```

Data honesty is enforced by construction: a reading carries its freshness,
source, and timestamp, and an unavailable reading always carries a reason. A
missing value renders as an explicit state, never as `0`, `-`, or an empty
string.

## Development setup

Install [Bun](https://bun.sh/) and the [Rust toolchain](https://www.rust-lang.org/tools/install). Tauri also requires platform-specific native build dependencies; see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system and Linux distribution. Run app commands from `app/`:

```sh
cd app
bun install
bun run tauri dev
```

Useful commands:

```sh
cd app
bun run dev          # Run the Vite client only
bun run start        # Start the native Tauri app
bun run restart      # Stop app-owned processes and restart the native app
bun run build        # Type-check and build the client
bun run clean        # Remove Rust and frontend build artifacts
bun run clean:rust   # Remove Rust build artifacts only
bun run clean:frontend # Remove frontend build artifacts only
bun run tauri dev    # Run the native desktop app in development
bun run tauri build  # Build a native package for the current target
```

Native packages should be built and tested on their target operating systems (or with a properly configured cross-compilation toolchain). A successful build on one platform does not verify support for every OS or Linux distribution.

The app client uses `~/` as its source alias (for example, `~/components/ui/button`). Add shadcn/ui components from `app/` with:

```sh
bunx shadcn@latest add button
```

## Testing

Work test-first. Write the smallest focused test that describes the new behaviour or reproduces the bug, watch it fail for the right reason, then implement.

End-to-end tests drive the **real compiled app** through its native webview — the Rust backend runs and the OS window exists:

```sh
cd app
bun run e2e
```

`bun run e2e` builds the frontend and the binary before running the suite, so the tests never run against a stale build. Use it instead of invoking `wdio` directly.

**Any UI change requires e2e coverage** — layout, copy, state rendering, navigation, interaction, or data display. A passing type-check or build is not a substitute: neither can show that a screen renders the right value, handles a missing or stale response, or stays usable at narrow widths. There is no exemption for small or styling-only changes.

E2E specs live in `app/e2e/specs/`. Run artifacts (screenshots and dumps) are written to `.temp/e2e/`, which is git-ignored.

For Rust changes, also run:

```sh
cargo fmt --manifest-path app/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path app/src-tauri/Cargo.toml --all-targets -- -D warnings
```

The suite is currently verified on macOS only; Windows and Linux are configured but unproven. See [`AGENTS.md`](AGENTS.md) and [`.opencode/rules/testing.md`](.opencode/rules/testing.md) for the full policy.

## Integrations and credentials

### Codex

Codex is integrated by spawning `codex app-server --stdio` and speaking its
JSON-RPC protocol over stdio. It requires **no API key and no secret storage**:
the child process inherits the session you already created with `codex login`,
so no token ever reaches this app, the renderer, or any file it writes.

Usage is read with `account/rateLimits/read`, which returns the 5-hour and
weekly windows as `{ usedPercent, windowDurationMins, resetsAt }`.

### Rolling the 5-hour window — what actually happens

The window is **not** something a prompt can restart. `resetsAt` is computed by
the provider and is only ever read, never derived, anywhere in the Codex
codebase. Sending a prompt **consumes** the current window rather than opening a
fresh one.

What the app does instead is **detect** the rollover: it polls on an interval
and compares `resetsAt` across readings, raising a notice when the value moves
forward. That is the only locally observable signal that a new window opened —
the provider emits no reset event.

A minimal "hi" prompt is implemented behind `sendPing`, but it is never fired on
a timer. It spends quota, so the client only reaches it from a setting the user
explicitly enabled.

### Other providers

Z.ai and Claude Code are **not implemented**. The `Provider` trait and the
registry exist so that adding one is a registration line plus a module — no
change to `automation`, `widget`, or `lib.rs`.

When adding providers, prefer documented and authorized provider interfaces,
make the source and timestamp of status/usage data visible, and handle missing
or stale data explicitly. Never commit API keys, session tokens, account data,
or local environment files.

## License

This project uses a custom license based on Apache License 2.0 with an additional restriction prohibiting redistribution for commercial advantage or monetary compensation. See [`LICENSE`](LICENSE) for the complete terms. This is not the unmodified Apache-2.0 license or an OSI-approved open-source license; do not label it `Apache-2.0`. Third-party dependencies remain under their respective licenses.
