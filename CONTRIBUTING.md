# Contributing

Thank you for your interest in improving AgentGauge. Contributions should make the app more useful without weakening its data accuracy, privacy, or user-control guarantees.

## Before you start

1. Read the [README](README.md) for current capabilities and setup.
2. Read the [PRD](docs/PRD.md) before proposing product or integration work. Its harness integration order and capability boundaries are intentional.
3. For substantial changes, open an issue or discussion first to agree on scope and feasibility.
4. Check the [license](LICENSE) before contributing. This project has a custom license with a commercial redistribution restriction; it is not OSI-approved open source. Contributions are submitted under the terms described in that license unless a separate written agreement applies.

## Project boundaries

- Integrate with locally installed coding harnesses through documented, authorized interfaces. Do not add direct model-provider API integrations.
- The harness owns authentication, provider configuration, subscriptions, and credentials. Do not request, read, copy, mutate, store, or log credential material.
- Do not present ACP session/context usage as subscription allowance. Do not infer a reset window from elapsed time, model catalogs, or session activity.
- Keep unsupported, stale, unavailable, or unknown data explicit; never replace it with a fabricated value or zero.
- Any inference-consuming automation must be explicitly enabled, account/harness scoped, observable, and stoppable. Never send a prompt from tests or on a timer without explicit user opt-in.
- Preserve the macOS WidgetKit architecture and its constraints. Read `app/src-tauri/widget/README.md` before changing widget build or embedding behavior.
- Do not claim unverified provider or platform support. macOS is the only exercised platform at this time.

## Development setup

Install Bun, Rust, and the native dependencies for Tauri on your platform. Then:

```sh
cd app
bun install
bun run tauri dev
```

Use Bun for JavaScript package operations. Keep `app/bun.lock` and `app/src-tauri/Cargo.lock` in sync when dependencies change.

## Making changes

- Prefer a focused change that solves one problem.
- Follow the existing TypeScript/React and Rust style and preserve the architecture in `AGENTS.md`.
- For Rust, keep dependency direction downward: composition root → modules → shared → crates. Avoid cycles and sideways imports between sibling modules.
- Keep harness-specific logic in its adapter/module rather than coupling it into generic UI.
- Add or update tests for behavior changes. Work test-first: establish a focused failing test, implement the smallest change, then keep the test green.
- UI behavior changes require a native end-to-end spec asserting the rendered result.
- Never include real account data, API keys, tokens, cookies, local environment files, or provider credentials in code, fixtures, logs, or screenshots.

## Required checks

Run checks relevant to your changes. For client changes:

```sh
cd app
bun run build
bun run test
bun run e2e
```

`bun run e2e` builds the frontend and native binary before running WebdriverIO against the real Tauri window. Do not replace it with a bare `wdio` invocation. UI changes must include a spec under `app/e2e/specs/` and the suite must actually run.

For Rust changes, from the repository root:

```sh
cargo fmt --manifest-path app/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path app/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo check --manifest-path app/src-tauri/Cargo.toml
```

Add `cargo test --manifest-path app/src-tauri/Cargo.toml` for Rust behavior changes. Native packaging and widget changes need target-platform verification. Report checks you could not run; do not claim they passed. See [`.opencode/rules/testing.md`](.opencode/rules/testing.md) for the full matrix and harness guidance.

Tests must not require network access, API keys, or a live provider account. Mock provider responses at the IPC or protocol boundary. Never run a test that could send a real prompt or otherwise mutate a real account.

## Pull requests

- Use a clear title and explain the problem, the approach, and any user-visible behavior change.
- Link the relevant issue or PRD requirement where applicable.
- Include tests and list the exact validation commands run, with platform details for native checks.
- Call out new permissions, data collection, subprocess behavior, network access, or quota-consuming actions explicitly.
- Include screenshots for visual changes when useful; never include sensitive account information.
- Keep unrelated formatting, generated files, build output, and local configuration out of the PR.
- Update documentation when setup, supported behavior, platform requirements, or product claims change.

## Documentation contributions

Keep the README concise and factual: current functionality must remain separate from planned integrations and roadmap items. The PRD defines product direction; do not use it to imply that a feature has shipped.

## Recognition

Contributors are recognized in [CONTRIBUTORS.md](CONTRIBUTORS.md). Please add your preferred public name or handle through a pull request if you would like to be listed. Recognition is optional; Git history remains the authoritative record of code contributions.
