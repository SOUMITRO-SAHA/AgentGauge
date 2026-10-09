# Agent guidance

## Project intent

This is an early-stage Tauri 2 desktop app and native-widget project for AI subscription statistics, account/service status, and related automation. Intended provider coverage includes Codex, Claude Code, Z.ai, and additional services over time. The primary platform goals are macOS, Windows, and Linux.

The current UI and Rust backend are still the Tauri starter greeting example. Do not describe provider integrations, monitoring, automation, or widget behavior as implemented unless the code actually implements them.

## Project structure and conventions

- `app/`: Tauri desktop application; keep all Tauri configuration and code here.
- `app/src/`: React and TypeScript client.
- `app/src/components/ui/`: shadcn/ui components.
- `app/src/lib/utils.ts`: shared `cn()` class-name utility.
- `app/src-tauri/`: Tauri configuration and Rust backend.
- `website/`: reserved for a future Astro landing page and documentation site. Do not add it to the app build.
- Use the `~/` alias for imports from `app/src` (for example, `~/lib/utils`). Keep it aligned in `app/vite.config.ts`, `app/tsconfig.json`, and `app/components.json`.
- Styling uses Tailwind CSS 4 through `@tailwindcss/vite`; do not add a Tailwind 3 config unless the project is deliberately migrated.
- Follow the surrounding TypeScript/React and Rust style. Keep provider-specific code modular rather than coupling provider behavior into general UI components.
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
