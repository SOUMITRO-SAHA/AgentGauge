# AgentGauge Roadmap

This roadmap summarizes the product direction in the [Product Requirements Document](docs/PRD.md); it is not a dated delivery commitment. The repository's current application version is **0.1.0**. Its launch scope and the rules for keeping new feature work out of that release are recorded in the [v0.1.0 feature lock](docs/releases/v0.1.0-feature-lock.md). An implemented feature is not automatically release-verified.

## Product direction

AgentGauge is a local-first desktop companion for AI coding harnesses and the coding plans they expose. It presents usage and reset information only where a supported source reports it, keeps source and freshness visible, and provides optional user-controlled kickoff actions where implemented.

Codex usage comes from the local `codex app-server`. For the currently supported OpenCode-connected coding plans, AgentGauge discovers plan configuration through OpenCode and reads supported plan data from documented provider coding-plan endpoints using credentials managed by OpenCode. The app does not ask the user to enter credentials or perform sign-in.

A kickoff consumes quota. It does not create, restart, reset, or extend a provider's usage window. The current scheduler follows the latest reported reset and does **not** verify that a rollover occurred; it must not be described as verified-rollover automation.

## Current release: 0.1.0

**Implementation status: feature set recorded and frozen; launch verification and release-policy decisions remain open.** See the [feature lock](docs/releases/v0.1.0-feature-lock.md) for the full implemented-scope inventory, explicit exclusions, and release gates.

The current implementation includes:

- Codex five-hour and weekly usage readings, reset timestamps, freshness/status states, and observed changes to reported `resetsAt` values.
- Supported OpenCode-connected Z.AI, MiniMax, and Kimi coding-plan readings; unsupported or unavailable data is kept distinct from zero.
- Persisted, read-only rollover monitors per readable connection, with a Home status glance.
- Per-connection opt-in scheduled kickoff for supported connections, with available model/effort selection, history/status, and macOS background scheduling. Scheduling is based on reported resets, not a positively verified rollover.
- Local usage analytics and estimated API-equivalent costs with source/coverage distinctions. These are not provider invoices or a unified subscription-usage total.
- A read-only Processes screen for tracked toolchain process and local-storage information.
- A macOS WidgetKit extension built separately and manually placed by the user. Gallery availability has not yet been confirmed in the documented verification environment.
- Onboarding, settings, and durable local state.

macOS is the only exercised desktop platform. Windows and Linux are not verified. Release readiness is not implied by this feature inventory: native packaging, focused end-to-end checks, the outstanding suite failures, and the policy questions in the feature lock must be closed or explicitly accepted before publishing.

## Next roadmap work

### 1. Release hardening and truthful capability boundaries — In progress

- Close the v0.1.0 release gates without adding new features to the locked scope.
- Reconcile implementation with the PRD on local-history analytics permission, provider coding-plan endpoint use, and kickoff eligibility semantics.
- Verify whether the embedded macOS widget appears in the system gallery; advertise it only to the degree actually verified.
- Keep unsupported, stale, unavailable, and unverified states explicit.

**Gate:** A release owner accepts or resolves each policy question; required checks pass; package and release claims match the tested artifacts.

### 2. Verified rollover and automation safety — Planned

- Only describe a rollover as verified when fresh source snapshots prove a transition to a new provider-reported window.
- If scheduled kickoff is brought into alignment with the PRD, send only after that proof, with durable once-per-rollover deduplication and a clear skip/failure record.
- Preserve per-connection explicit opt-in. Never test against a real account by sending a prompt unless the user explicitly authorizes the quota-consuming action.

**Gate:** No early, duplicate, speculative, or unverified sends; otherwise the feature remains clearly labeled as following reported reset times or is disabled.

### 3. Broader OpenCode harness integration — Planned

- Evaluate OpenCode's documented harness interfaces for connection, model/session discovery, and capability reporting independently from the existing connected-plan readers.
- Keep session/context usage distinct from subscription allowance. Do not infer reset times or entitlement from ACP/session telemetry.
- Add automation only if the exact connection exposes verifiable reset semantics and enforces the selected model.

**Gate:** A documented OpenCode capability report and regression coverage; unsupported subscription fields remain explicit.

### 4. Pi integration — Planned

- Evaluate Pi's supported local RPC and any maintained ACP adapter.
- Add only capabilities verified against supported versions and platforms.

**Gate:** Tested integration with documented capability and unsupported-state coverage.

### 5. Additional coding harnesses — Future

- Evaluate Claude Code, Kilo Code, Kimi Code, and other compatible coding harnesses individually, after the integration priorities above.
- Treat an adapter or model catalog as an integration path, not proof of subscription monitoring or kickoff eligibility.

**Gate:** Each integration has authorized interfaces, documented limits, platform evidence, and regression tests.

### 6. Analytics expansion and permission model — Research-gated

- Improve the existing local analytics only with explicit decisions on local-history access, data coverage, retention/deletion, and permission revocation.
- Preserve provenance and distinguish observed tokens, estimates, provider-reported usage, and billed cost.
- Never combine readings with incompatible time spans into a misleading total.

**Gate:** The permission model is explicit, coverage and pricing assumptions are visible, and user-controlled exclusion/deletion is defined.

### 7. Multiple accounts — Final phase

- Defer account profiles and switching until harness-owned isolation and exact action targeting are proven.
- Keep credentials owned by the harness and require independent action authorization per profile.

**Gate:** No cross-profile actions or silent identity changes; account-scoped deduplication is proven.

## Principles and exclusions

- Do not invent usage, model-to-entitlement mappings, reset windows, or costs.
- A prompt cannot open or restart a provider's usage window; `sendPing` and kickoff consume quota.
- Do not imply AgentGauge installs or detects placement of the macOS system widget.
- Do not claim Windows/Linux or non-macOS widget support without target-specific evidence.
- Do not treat connected-plan readers as a complete native OpenCode harness integration.
- Cloud synchronization and a hosted backend are not currently planned.
- Do not add features to a locked release silently. Versioned changes require the change-control process in the feature lock.

## Updating this roadmap

The PRD remains the source for product requirements and acceptance criteria, but its implementation inventory must be reconciled when product decisions change. The feature lock is authoritative for the exact scope and exceptions of a named release. Mark work complete only when implementation evidence exists; mark release verification separately. Use status labels rather than dates unless a delivery date is explicitly committed.
