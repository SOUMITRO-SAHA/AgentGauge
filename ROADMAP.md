# AgentGauge Roadmap

This roadmap summarizes the product direction in the [Product Requirements Document](docs/PRD.md). It is a sequence of goals and release gates, **not a dated delivery commitment**. Harness capabilities and platform support will be advertised only after they are verified.

## Product direction

AgentGauge is a local-first desktop companion for AI coding harnesses. Its two pillars are:

- **Subscription observability:** Show trustworthy usage windows, reset information, freshness, and capability gaps from supported local harness interfaces.
- **User-controlled kickoff:** Optionally send one minimal `Hi` through a selected harness and user-selected model one minute after a verified rollover.

The app integrates with coding harnesses, not model-provider APIs. Harnesses own authentication, provider configuration, subscriptions, and credentials. A kickoff consumes quota; it does **not** cause, reset, or extend a provider's usage window.

## Current status

**In progress — Codex monitoring foundation.** Codex is the only implemented harness. The app reads reported five-hour and weekly usage windows through the local `codex app-server`, tracks freshness, and observes `resetsAt` changes as a rollover-related signal. A manually initiated ping capability exists and consumes quota. Automatic kickoff, model selection, other harness integrations, local activity analytics, and multi-account support are not implemented.

macOS is the only platform exercised so far. Windows and Linux support must be verified independently.

## Integration order

1. **Codex** — current integration and first kickoff target.
2. **OpenCode** — next harness.
3. **Pi** — third harness.
4. **Claude Code, Kilo Code, Kimi Code, and other compatible harnesses** — evaluated individually afterward.

ACP or another prompt interface is not proof that a harness exposes subscription limits or reset times. Each capability is assessed separately. See the PRD for detailed integration requirements.

## Roadmap phases

### 0. Codex monitoring foundation — In progress

- Harden Codex app-server usage reads, five-hour and weekly windows, freshness, and widget behavior.
- Validate active-context detection and candidate `resetsAt` transitions.
- Keep unsupported fields and manual ping behavior accurately represented.

**Release gate:** Accurate Codex-only status, with no automatic prompts.

### 1. Codex model selection and post-rollover kickoff — Planned

- Discover models through the harness and let users select a model for kickoff.
- Verify model selection on the exact minimal Codex session before sending.
- Confirm real, fresh rollovers and persist once-per-rollover deduplication.
- If explicitly enabled, send exactly one `Hi` one minute after a verified rollover.
- Add enable/pause controls, reset timeline, audit history, skip/failure reasons, and offline handling.
- Keep automation off by default; skip ambiguous or missed rollovers rather than sending speculative catch-up prompts.

**Release gate:** Correct model targeting, no duplicate sends, and no early or unverified sends.

### 2. OpenCode integration — Planned

- Add supported ACP connectivity, model/session discovery, and any authorized local status interface needed for usage visibility.
- Clearly separate session/context usage from subscription allowance.
- Reuse kickoff only where the subscription window, rollover, and model selection are verified.
- Provide a truthful partial integration when reset information is unavailable.

**Release gate:** OpenCode works within demonstrated capabilities; unsupported subscription statistics are never inferred.

### 3. Pi integration — Planned

- Evaluate Pi's supported local RPC interface and compatible ACP adapters.
- Discover verified model, session, and usage capabilities.
- Add reset monitoring or kickoff only if trustworthy window semantics and model enforcement are proven.

**Release gate:** A tested Pi integration with a documented capability report and explicit unsupported states.

### 4. Additional coding harnesses — Future

- Evaluate Claude Code, Kilo Code, Kimi Code, then other qualifying harnesses individually.
- Prefer maintained, documented ACP or comparably safe local interfaces.
- Ship only verified capabilities; an adapter alone does not establish subscription monitoring or kickoff eligibility.

**Release gate:** Each harness has documented limits, platform verification, and regression coverage.

### 5. Permissioned local activity analytics — Research-gated

- Research what local activity metadata each harness exposes and its coverage.
- Require separate, explicit user permission before reading local histories or workspace metadata.
- Prefer on-device processing; provide source/coverage information, exclusions, export, deletion, and permission revocation.
- Consider token summaries and dated API-equivalent estimates only when source fields and pricing semantics are defensible.

**Release gate:** Clear consent, trustworthy calculations, visible coverage limits, and user-controlled data deletion.

### 6. Multiple accounts — Final phase

- Evaluate harness-owned profiles and account isolation without taking ownership of credentials.
- Add separately identified profiles only when the harness can target them reliably.
- Require independent opt-in and durable per-profile action tracking for kickoff.

**Release gate:** No cross-profile actions or silent identity changes; account-scoped deduplication is proven.

## Principles and exclusions

- Never call a model-provider API directly or manage provider credentials.
- Do not invent reset windows, usage values, model-to-entitlement mappings, or cost data.
- Treat missing, stale, unsupported, and unavailable information as distinct states.
- Keep inference-consuming actions explicitly opt-in, visible, bounded, and stoppable.
- Do not optimize for prompts sent or quota consumed.
- Do not claim Windows/Linux or widget support without platform-specific evidence.
- Cloud synchronization and a hosted backend are not currently planned.

## Updating this roadmap

The PRD is the source of truth for requirements, acceptance criteria, and technical feasibility. Update this summary when roadmap priorities or release gates change. Record shipped work as complete only after its gate is met; do not add dates unless the project commits to them.
