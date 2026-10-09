# AI Subscription Stats

A cross-platform desktop app and native-widget project for keeping track of AI subscriptions, usage statistics, service status, and related automations in one place.

The goal is to support subscriptions and tools such as OpenAI Codex, Claude Code, and Z.ai, with an architecture that can grow to include other AI providers. The primary desktop targets are macOS, Windows, and Linux, with Linux distribution compatibility to be validated as the app develops.

> **Project status:** Early scaffold. The current app is still based on the default Tauri greeting example. Provider integrations, subscription statistics, status monitoring, automations, and the widget experience are planned work and are not implemented yet.

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
- Vite 8 for development and production builds
- Tailwind CSS 4 and shadcn/ui for styling and UI components
- Bun for JavaScript dependencies and scripts

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
bun run build        # Type-check and build the client
bun run tauri dev    # Run the native desktop app in development
bun run tauri build  # Build a native package for the current target
```

Native packages should be built and tested on their target operating systems (or with a properly configured cross-compilation toolchain). A successful build on one platform does not verify support for every OS or Linux distribution.

The app client uses `~/` as its source alias (for example, `~/components/ui/button`). Add shadcn/ui components from `app/` with:

```sh
bunx shadcn@latest add button
```

## Integrations and credentials

Provider support has not been implemented yet. When adding it, prefer documented and authorized provider interfaces, make the source and timestamp of status/usage data visible, and handle missing or stale data explicitly. Never commit API keys, session tokens, account data, or local environment files. Avoid logging credentials or other sensitive account information.

## License

This project uses a custom license based on Apache License 2.0 with an additional restriction prohibiting redistribution for commercial advantage or monetary compensation. See [`LICENSE`](LICENSE) for the complete terms. This is not the unmodified Apache-2.0 license or an OSI-approved open-source license; do not label it `Apache-2.0`. Third-party dependencies remain under their respective licenses.
