# AgentGauge

**AgentGauge is a local-first desktop companion for AI coding harnesses.** It brings together the usage and reset information those harnesses actually expose, with planned, opt-in kickoff automation after a verified usage-window rollover.

The desktop app is displayed as **AgentGauge**. Its Rust process is named
`agentgauge-daemon` so it is recognizable in process listings; the background
poller currently runs inside the app process and is not a separately installed
system daemon. The existing app-data identifier and snapshot directory remain
stable for saved-state compatibility.

The app integrates with **coding harnesses, not model-provider platforms directly**. It uses harness-supported local interfaces such as app-server, ACP, CLI, SDK, or RPC. The harness remains responsible for sign-in, provider configuration, subscriptions, and credentials.

> [!IMPORTANT]
> **Current implementation: Codex only.** The app reads Codex five-hour and weekly usage windows, observes changes to the reported reset timestamp, and includes a manually initiated ping capability. **Automatic kickoff, model selection, OpenCode, Pi, later harnesses, local activity analytics, and multi-account support are not implemented today.** macOS is the only platform exercised so far.

## Product direction

The product has two pillars:

- **Subscription observability:** Show supported harnesses, reported usage windows and reset times, status, data freshness, and capability gaps without inventing missing information.
- **User-controlled kickoff automation:** Planned behavior is to send one minimal `Hi` prompt through a selected harness and user-selected available model, one minute after a verified usage-window rollover. It is off by default, consumes quota, and does not cause, reset, or extend the provider's window.

### Integration priority

The planned order is fixed:

1. **Codex** — current and first integration.
2. **OpenCode** — second.
3. **Pi** — third.
4. **Claude Code, Kilo Code, Kimi Code, and other compatible coding harnesses** — evaluated individually afterward.

An ACP connection or model catalog does not by itself provide subscription limits or prove that a model uses a particular subscription. Each harness capability must be verified independently. Multi-account support is deferred to the final roadmap phase; advanced activity analytics require separate research and explicit permission.

See the [Product Requirements Document](docs/PRD.md) for the full scope, capability requirements, safety rules, acceptance criteria, and roadmap.

## What works today

- Codex usage is read through the locally installed `codex app-server`; the app does not call OpenAI's provider API or ask for API credentials.
- The app displays the reported five-hour and weekly windows and freshness/status information.
- The app observes changes in Codex's reported `resetsAt` value as a rollover-related signal. This is not yet the verified trigger for an automatic send.
- A manually initiated `sendPing` capability exists and consumes quota. It is not an automatic post-rollover kickoff.
- The macOS WidgetKit extension displays usage snapshots. The user adds it from the macOS widget gallery; the app cannot install it or check whether it was placed.

The widget requires **macOS 14+ and Xcode 16+**. Build the macOS app and embed the extension with `bun run build:mac` from `app/`. See [`app/src-tauri/widget/README.md`](app/src-tauri/widget/README.md) before changing the extension or its build process.

OpenCode, Pi, Claude Code, Kilo Code, Kimi Code, automatic kickoff, user-selectable models, multi-account support, and local usage-history analytics are **planned or under investigation**, not shipped integrations or features.

## Usage-window behavior

The provider controls its usage window and reported reset timestamp. A prompt cannot force, start, restart, or extend that window; a prompt consumes quota in the current window. The planned kickoff sends `Hi` only after a real rollover has been verified, so it becomes initial activity in the naturally available window. If the rollover or selected harness/model cannot be verified, the planned behavior is to skip rather than send speculatively.

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

The opt-in icon generator copies only macOS, Windows, and Linux assets into
`app/src-tauri/icons/`. Tauri's CLI currently creates mobile files as part of
its generation command, so those are isolated in a temporary directory and
discarded; they are never copied into the app. To use another square SVG/PNG or
write the generated icons elsewhere, pass the source and destination after `--`:
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

Read [`AGENTS.md`](AGENTS.md) and the rules under [`.opencode/rules/`](.opencode/rules/) before making architectural or testing changes. `website/` is reserved for a future site and is not part of the app build.

## Contributing

Bug reports, documentation improvements, tests, and focused implementation proposals are welcome. Before starting substantial work, read the PRD and [contribution guidelines](CONTRIBUTING.md). They explain the harness-first integration boundary, test requirements, privacy expectations, and the project's license.

See [CONTRIBUTORS.md](CONTRIBUTORS.md) for contributor recognition.

## License

This repository uses a **custom license based on Apache License 2.0 with an additional restriction on commercial redistribution**. It is not the unmodified Apache-2.0 license and is not an OSI-approved open-source license. Review [`LICENSE`](LICENSE) before using, modifying, or redistributing the project. Third-party dependencies are governed by their respective licenses.
