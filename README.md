<div align="center">
  <img src="app/public/brand_logo.png" alt="AgentGauge logo" width="128" />
</div>

# AgentGauge

[![GitHub Discussions](https://img.shields.io/github/discussions/SOUMITRO-SAHA/AgentGauge?logo=github)](https://github.com/SOUMITRO-SAHA/AgentGauge/discussions)

**AgentGauge is a local-first desktop companion for AI coding harnesses.** It brings together usage and reset information exposed by local harness interfaces, with opt-in kickoff automation scheduled from the latest reported reset—not a verified rollover.

The desktop app is displayed as **AgentGauge**. Its Rust process is named
`agentgauge`; the background poller currently runs inside the app process and
is not a separately installed system daemon. The app identifier is
`com.soumitrasaha.agentgauge`, and shared widget/kickoff data lives in
`~/Library/Application Support/AgentGauge/`. Existing files are migrated from
the previous product directory on first use.

AgentGauge uses local harness interfaces such as app-server, CLI, ACP, SDK, or RPC for status and connected-plan discovery. For OpenCode-connected coding plans, it also calls documented provider coding-plan endpoints using credentials retrieved from OpenCode's local store. It does not perform sign-in or manage provider credentials.

> [!IMPORTANT]
> **Current implementation:** Codex usage is read through `codex app-server`; the app discovers OpenCode-connected coding plans and models through OpenCode's local CLI, then reads supported plan data from provider coding-plan endpoints. OpenCode supplies stored credentials and its local session database supplies the local Stats history for supported plans without provider token history. Opt-in kickoff is available per connection for Codex and supported connected plans. Model choices are limited to harness-exposed models present in the bundled price list; that list only orders choices and does not verify subscription access or predict quota impact. The schedule follows reported reset times without verifying rollover. Pi, Claude Code, Kilo Code, and multi-account support are not implemented. macOS is the only platform exercised so far.

## Product direction

The product has two pillars:

- **Subscription observability:** Show supported harnesses, reported usage windows and reset times, status, data freshness, and capability gaps without inventing missing information.
- **User-controlled kickoff automation:** An explicit per-connection opt-in sends one small `Hi` prompt using the selected model and effort. A future reported reset schedules it about a minute later; without one, the first attempt may be immediate. It consumes quota, does not verify rollover, and cannot cause, reset, or extend the provider's window.

### Integration priority

The implementation roadmap is:

1. **Codex** — current usage source and kickoff interface.
2. **OpenCode** — currently supplies connected plan/model discovery and stored credentials for supported coding plans; usage comes from the coding-plan providers, not OpenCode's own usage history.
3. **Pi** — third.
4. **Claude Code, Kilo Code, Kimi Code, and other compatible coding harnesses** — evaluated individually afterward.

An ACP connection or model catalog does not by itself provide subscription limits or prove that a model uses a particular subscription. Each harness capability must be verified independently. Multi-account support is deferred to the final roadmap phase. Local activity analytics are enabled by default without a separate consent prompt and remain distinct from provider-reported usage.

See the [Product Requirements Document](docs/PRD.md) for the full scope, capability requirements, safety rules, acceptance criteria, and roadmap.

## What works today

- Codex usage is read through the locally installed `codex app-server`; the app does not call OpenAI's provider API or ask for API credentials.
- Read-only CLI detection checks Codex and OpenCode with `--version`, independently of usage support. It searches the inherited path, macOS launchd path, and common install locations; `AGENTGAUGE_CODEX_PATH` and `AGENTGAUGE_OPENCODE_PATH` can select absolute executable paths without sourcing shell startup files.
- The app displays the reported five-hour and weekly windows and freshness/status information.
- The app observes changes in the reported `resetsAt` value as the rollover signal.
- Usage tabs cover every connected coding plan: Codex plus the OpenCode-connected Z.AI, MiniMax, and Kimi plans (Z.AI live-verified; MiniMax/Kimi decode from vendor-documented endpoints and degrade to explicit unavailable).
- **Stats analytics:** Provider-reported token history is available for Codex and Z.AI. Local Codex rollout and OpenCode session records supply session statistics and model-over-time breakdowns where provider history is unavailable. The Z.AI daily cost trajectory is an API-equivalent estimate based on the bundled price list, not a bill; unknown model prices and incomplete coverage remain explicit.
- **Scheduled kickoff (opt-in, macOS):** per connection, the user can choose a harness-exposed model that also appears in the bundled price list, then choose an effort while stopped. The initial model is the lowest-ranked listed price; enabling resets effort to that model's lowest supported level and locks configuration until stopped. Price ranking is not a subscription-quota estimate and does not guarantee plan access. A scheduled "Hi" follows the latest reported reset without verifying rollover; it spends quota and cannot start or reset a window. A `launchd` LaunchAgent runs the same binary headless once a minute while the app is closed; the schedule file lives beside the widget snapshot in `~/Library/Application Support/AgentGauge/`.
- A manually initiated `sendPing` capability exists and consumes quota.
- A read-only **Processes** screen shows the running processes, memory, and listening TCP ports of Codex and OpenCode, plus each one's on-disk data footprint with a breakdown — Codex's session transcripts, archived transcripts, and SQLite databases (`state_5`, `thread_history`, goals, logs, memories, queue), OpenCode's session storage, logs, and `opencode.db`. Ports are shown when the platform can report them (macOS/Linux via `lsof`); a stdio server such as `codex app-server` is reported as listening on nothing, which is the true answer, and platforms without an inspector say so. Groups with nothing running and unreadable or not-yet-created data directories say so instead of showing a zero. The screen cannot stop, signal, or delete anything — the capability has no write.
- The macOS WidgetKit extension shows the selected provider's 5-hour and weekly quotas, with arrows to switch among providers that have a reading. The user adds it from the macOS widget gallery; WidgetCenter can report whether an AgentGauge widget is configured, but the app cannot install it or determine its placement location.

The widget requires **macOS 14+ and Xcode 16+**. Build the macOS app and embed the extension with `bun run build:mac` from `app/`. See [`app/src-tauri/widget/README.md`](app/src-tauri/widget/README.md) before changing the extension or its build process.

## macOS distribution status

There is no public release to install yet. The planned macOS channels are a
universal DMG, a Homebrew Cask, and a platform-checking installer at
`curl -fsSL https://agentgauge.soumitrasaha.com/install.sh | sh`. Release
artifacts and the separately Tauri-signed in-app updater feed are published as
GitHub release assets on this public repository — there is no R2 bucket, CDN,
or download proxy; publishing is a manual release workflow, not an automatic
tag action. Direct installs use the signed in-app updater; Brew-managed copies
ask before running a Homebrew upgrade and offer restart only after success. These routes
will be advertised only after the tap and updater key are configured and verified.
The initial distribution uses ad-hoc code signing and is not notarized, so
macOS may require users to approve the first launch. See
[`docs/updates/macos.md`](docs/updates/macos.md) for setup, costs, and remaining
release gates.

Pi, Claude Code, Kilo Code, multi-account support, and analytics beyond those described above are **planned or under investigation**, not shipped integrations or features. Background scheduling on Windows and Linux is unimplemented.

## Usage-window behavior

The provider controls its usage window and reported reset timestamp. A prompt cannot force, start, restart, or extend that window; it consumes quota in whichever window is active when the provider handles it. Kickoff schedules a prompt from the latest reported reset time, does not verify that rollover occurred, and does not guarantee that a new window has opened. It never sends without the user's explicit per-connection opt-in.

## Development setup

Install [Bun](https://bun.sh/), the [Rust toolchain](https://www.rust-lang.org/tools/install), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system. Run app commands from `app/`:

```sh
cd app
bun install
bun run tauri dev
```

Useful commands:

```sh
cd app
bun run dev            # Run the Vite client only
bun run start          # Start the native Tauri app
bun run build          # Type-check and build the client
bun run test           # Run unit and component tests
bun run e2e            # Build and test the real native app
bun run tauri build    # Build a native package for the current target
bun run build:mac      # Build the macOS app and WidgetKit extension
bun run icons:generate # Regenerate desktop icons from public/logo.svg
```

The icon generator copies only macOS, Windows, and Linux assets into
`app/src-tauri/icons/`. Tauri's CLI currently creates mobile files as part of
its generation command, so those are isolated in a temporary directory and
discarded; they are never copied into the app. Generated desktop icons use the
brand-ink background and near-white mark; the master SVG stays transparent. To
use another SVG or write the generated icons elsewhere,
pass the source and destination after `--`:
`bun run icons:generate -- path/to/logo.svg path/to/output`.

Native dependencies and packaging are platform-specific. A successful build on one operating system does not verify other operating systems or Linux distributions. macOS is currently the only exercised platform.

## Testing

Contributions should be test-first: write the smallest focused test, confirm it fails for the intended reason, then implement the change. Any UI change needs an end-to-end spec that checks the rendered behavior, and the suite must actually be run:

```sh
cd app
bun run build
bun run test
bun run e2e
```

For Rust changes, also run:

```sh
cargo fmt --manifest-path app/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path app/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo check --manifest-path app/src-tauri/Cargo.toml
```

The e2e suite drives the compiled app in its native webview and is verified on macOS only. Read [CONTRIBUTING.md](CONTRIBUTING.md) for change-specific gates and PR expectations.

## Architecture

The renderer and Rust backend communicate through a single tagged protocol: `AppRequest` and `AppResponse` behind one Tauri `dispatch` command. The renderer validates IPC payloads at the boundary. Rust modules own bounded capabilities; provider/harness-specific behavior stays modular.

```text
app/
  src/                  React and TypeScript client
    lib/ipc.ts          Single typed IPC boundary
    atoms/              Client state
    components/         App views and UI
  src-tauri/
    src/shared/         Shared domain types and protocol
    src/modules/        Backend capabilities and integrations
    widget/             macOS WidgetKit extension
docs/PRD.md             Product requirements and roadmap
```

Read [`AGENTS.md`](AGENTS.md) and the rules under [`.opencode/rules/`](.opencode/rules/) before making architectural or testing changes.

The marketing site lives in [`website/`](website/) and is a separate Astro project deployed to Cloudflare Workers. It is independent of the app: it never imports app code and is never part of the app build. Run its commands from `website/`:

```sh
cd website
bun install
bun run dev      # Local dev server on :4321
bun run build    # Production build into dist/
bun run deploy   # Build and deploy to Cloudflare
```

The site publishes at `agentgauge.soumitrasaha.com`. Its copy follows the same honesty rules as this README: macOS is the only shipped platform, and a harness is listed as supported only once it has actually been read.

## Contributing

Bug reports, documentation improvements, tests, and focused implementation proposals are welcome. Questions, feature ideas, and setup help live in [Discussions](https://github.com/SOUMITRO-SAHA/AgentGauge/discussions) — start with the pinned welcome post for the community guidelines. Before starting substantial work, read the PRD and [contribution guidelines](CONTRIBUTING.md). They explain the harness-first integration boundary, test requirements, privacy expectations, and the project's license.

See [CONTRIBUTORS.md](CONTRIBUTORS.md) for contributor recognition.

## License

This repository uses a **custom license based on Apache License 2.0 with an additional restriction on commercial redistribution**. It is not the unmodified Apache-2.0 license and is not an OSI-approved open-source license. Review [`LICENSE`](LICENSE) before using, modifying, or redistributing the project. Third-party dependencies are governed by their respective licenses.
