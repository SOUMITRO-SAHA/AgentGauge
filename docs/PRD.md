# Product Requirements Document (PRD): AgentGauge

- **Status:** Final product-direction draft; integration feasibility remains subject to validation
- **Version:** 2.0
- **Last updated:** 2026-10-10
- **Product:** AgentGauge
- **Platform:** Desktop application (Tauri + Rust); macOS validated to date

> **Implementation disclaimer:** This document defines the agreed product direction and planned requirements. It does not imply that proposed harness integrations, model selection, scheduled kickoff, or analytics are already shipped.

## 1. Executive summary

AgentGauge is a local-first desktop companion for **AI coding harnesses**. It helps developers understand the subscription usage and reset information that their installed harnesses actually expose, and optionally sends a minimal `Hi` prompt after a verified, provider-controlled usage-window rollover using a model explicitly selected by the user.

The application integrates with **coding harnesses, not AI platforms directly**. It uses Agent Client Protocol (ACP) where supported, or other documented, authorized harness interfaces such as local app-server or RPC protocols. Authentication, provider configuration, subscriptions, and credentials remain managed by the user's existing harness. AgentGauge does not connect directly to model-provider APIs or manage provider credentials.

**Integration priority is fixed:**

1. **Codex** - first and current integration.
2. **OpenCode** - second.
3. **Pi** - third.
4. **Claude Code, Kilo Code, Kimi Code, and other compatible coding harnesses** - subsequent expansion, evaluated individually.

**Multi-account support is deferred to the final roadmap phase.** Advanced analytics require separate technical research and explicit user permission before implementation.

The product has two primary pillars:

- **Subscription observability:** Limits, usage windows, reset times, status, freshness, and clearly identified gaps.
- **User-controlled kickoff automation:** After a confirmed rollover, send one minimal `Hi` prompt through the selected harness and user-selected available model, subject to that harness exposing both a reliable reset signal and a safe prompt/model-selection path.

## 2. Product vision

Provide one trustworthy desktop location to inspect the state of installed AI coding harnesses and use newly available subscription windows with an optional, predictable kickoff action.

The product must not treat unlike harnesses or underlying subscription plans as interchangeable. An ACP connection can enable sessions and prompts without providing subscription reset data. Every metric and automated trigger must be backed by a proven harness-specific source.

### 2.1 Key user questions

- Which supported coding harnesses are installed, connected, or unavailable?
- What subscription or usage-limit information does each harness actually expose?
- How much of a reported window has been used, and when will it roll over?
- Is a reading fresh, cached, stale, unsupported, or unavailable?
- Which models can I select for a minimal kickoff prompt through a given harness?
- Did a rollover occur, was a kickoff scheduled or sent, and why was an action skipped?
- If I grant separate permission later, what local usage/activity analytics are available?

### 2.2 Terminology

- **Harness:** A locally installed AI coding agent or client such as Codex, OpenCode, Pi, Claude Code, Kilo Code, or Kimi Code.
- **Underlying subscription/entitlement:** The provider plan, quota, or billing arrangement used by the harness, if identifiable. One harness can expose models from multiple sources.
- **Usage window:** A limit interval reported by a supported source. A five-hour window must not be assumed for harnesses that do not expose one.
- **Reported reset:** A timestamp or state supplied by the harness's supported data interface, reflecting an underlying provider-controlled limit.
- **Observed rollover:** A positively verified transition between distinct usage windows, not merely the passage of local wall-clock time.
- **Kickoff:** One user-authorized prompt containing `Hi` sent after an observed rollover. It consumes usage; it does not create, reset, or extend a provider window.
- **Unsupported:** The harness is reachable but does not provide the requested capability via an accepted interface.

## 3. Product boundaries and integration policy

### 3.1 Harness-only integration

AgentGauge **must**:

- Communicate with locally installed coding harnesses through supported ACP, local app-server, CLI, SDK, or RPC surfaces, depending on each harness's documented integration path.
- Prefer ACP for generic agent sessions, prompt submission, and model/config selection where available.
- Use a harness-specific authorized local interface when subscription-limit visibility is not available through ACP.
- Detect and display harness version, connectivity, and the capabilities that have been verified.
- Work with the authentication and provider configuration already owned by the harness.

AgentGauge **must not**:

- Integrate directly with OpenAI, Anthropic, Moonshot, or other model-provider APIs to retrieve usage or send kickoff prompts.
- Ask users to enter provider API keys, passwords, OAuth tokens, or session cookies into AgentGauge.
- Read, copy, mutate, or store harness credential files.
- Automate logins, switch provider credentials behind the user's back, scrape private endpoints, or bypass provider policies.
- Claim a subscription window exists simply because a harness exposes an ACP prompt method.

If a harness is unauthenticated, the app displays **"Sign in using [harness]"** and does not perform the login itself.

### 3.2 Capability separation

The following are **independent** capabilities, not a single "ACP supported" flag:

| Capability         | Meaning                                                               |
| ------------------ | --------------------------------------------------------------------- |
| Discovery          | Installed harness and compatible local interface can be detected.     |
| Connection         | The harness can be initialized and queried safely.                    |
| Usage windows      | Supported interface returns genuine usage limits and reset semantics. |
| Rollover detection | Two or more trustworthy readings can establish a new window.          |
| Model discovery    | Available/selectable models are provided by the harness.              |
| Model enforcement  | The chosen model can be applied to the exact kickoff session.         |
| Prompt execution   | The harness can accept a minimal prompt and report its outcome.       |
| Local analytics    | Authorized activity metadata can be read with known coverage.         |

**Rule:** A harness may support monitoring without kickoff, kickoff-capable prompting without reset visibility, or neither. Only display and enable features whose prerequisites are verified.

### 3.3 ACP-specific limitation

ACP provides a standardized interaction path for agents and clients. Session token/context usage updates, when implemented, are **not** equivalent to subscription remaining allowance or reset timestamps. The app must not infer subscription rollover from context-window usage, model catalogs, session changes, or elapsed time.

## 4. Current implementation versus future scope

### 4.1 Implemented today

- Tauri desktop application with a Rust backend.
- **Codex-only** integration using the local `codex app-server` interface.
- Reads reported Codex five-hour and weekly usage windows and reset information.
- Observes changes in the reported `resetsAt` value as a rollover-related signal. Stronger eligibility verification is required before enabling scheduled sends.
- Rust-owned polling and status states for live, cached, stale, and unavailable readings, with reasons where known.
- Explicitly initiated `sendPing` capability that consumes quota.
- macOS WidgetKit extension showing usage snapshots; users place it manually from the system widget gallery.
- macOS is the only exercised platform; Windows and Linux are not verified.

### 4.2 Not implemented today

- Automatic post-rollover `Hi` kickoff.
- User-selectable kickoff model and per-harness scheduled automation.
- OpenCode, Pi, Claude Code, Kilo Code, Kimi Code, or other additional harness integrations.
- Generalized ACP harness discovery and capability matrix.
- Cross-harness activity analytics, token histories, and API-equivalent cost estimates.
- Multiple account profiles, account switching, or multi-account automation.

## 5. Target users and core jobs

### 5.1 Primary users

Developers who already use supported AI coding harnesses and want a quick, truthful view of usage limits and an optional way to kick off the next available window.

### 5.2 Jobs to be done

1. **Monitor:** View each installed and supported harness's available usage information and data freshness.
2. **Plan:** Understand reported window ends and optional non-consuming reminders.
3. **Configure:** Select a harness and one of its verifiably selectable models for a `Hi` kickoff.
4. **Automate:** Enable an explicitly authorized, once-per-observed-rollover kickoff with a reliable pause/stop control.
5. **Audit:** See whether a rollover was observed, a prompt was sent, or a send was skipped or failed.
6. **Analyze later:** Grant specific permission to import supported local activity metadata and inspect usage trends.

## 6. Goals, non-goals, and product principles

### 6.1 Goals

- Make Codex usage status accurate and understandable before broadening integrations.
- Build modular harness adapters without coupling the application to model-provider APIs.
- Grow in the fixed order: Codex, OpenCode, Pi, then Claude Code/Kilo/Kimi/others.
- Provide user-selected model control for supported kickoff implementations.
- Automate exactly one `Hi` after each eligible verified rollover, when explicitly enabled.
- Keep unsupported and unavailable fields visible as such.
- Keep advanced analytics separately permissioned and local-first.
- Preserve compact macOS widget usability.

### 6.2 Non-goals

- Direct AI-provider or billing-platform integration.
- Credential management, account provisioning, login automation, or provider subscription purchasing.
- Manufacturing, forcing, restarting, or extending any provider usage window.
- Guessing reset schedules for harnesses without a reliable reported window.
- Promising that every ACP agent exposes subscription stats or model-specific quota costs.
- Full multi-account management before the final phase.
- Cloud synchronization, a central credential vault, or mandatory hosted backend.
- Unverified Windows/Linux or system-widget support claims.

### 6.3 Principles

1. **Harness first:** Interact with the coding tool already installed and authenticated by the user.
2. **Source before UI:** Never show fabricated data or translate missing values into zero.
3. **Action requires proof:** A kickoff needs a verified rollover and a model that can be enforced for that exact action.
4. **One rollover, one kickoff:** No duplicate or speculative consumption.
5. **User choice:** Kickoff model, harness, and enable/disable state are explicit.
6. **Local by default:** Keep settings, snapshots, and later analytics on the user's device.
7. **No conflation:** Harness session statistics, subscription limits, and estimated monetary costs are distinct datasets.

## 7. Functional requirements

### 7.1 Harness discovery and overview

**Priority:** Foundation; expand by roadmap order.

- Detect supported local harness executables and relevant supported interfaces without initiating inference.
- Display installed/not installed, connected/disconnected, supported/unsupported capability states, and installed version when reliably available.
- Show a distinct card per harness; do not imply that each harness represents exactly one underlying subscription.
- Show verified usage windows and local reset times only when the source supplies those semantics.
- Display provenance, last successful refresh, and `live`, `cached`, `stale`, `unavailable`, or `unsupported` states.
- Explain missing metrics instead of showing zero or an invented percentage.
- Degrade independently: a failing OpenCode adapter must not blank Codex data.

**Acceptance criteria:** Users can distinguish which harnesses are connected and exactly which usage-window fields are trustworthy.

### 7.2 Codex usage and window monitoring

**Priority:** P0.

- Continue using the existing local Codex app-server integration; no direct OpenAI platform calls.
- Present the reported five-hour and weekly windows, used percentages, associated reset timestamps, and source freshness.
- Preserve actual source timestamps and avoid presenting locally calculated countdowns as authoritative provider timestamps.
- Use observed changes in `resetsAt` as candidate signals; confirm freshness, active harness identity, and a genuine new reported window before making automation eligible.
- Handle missing or ambiguous rate-limit bucket/model mapping as unknown rather than assigning a model to a quota bucket without evidence.
- Provide optional non-consuming reset reminders where reliable timestamps are available.

### 7.3 Model discovery and selection

**Priority:** P1 with Codex kickoff; reusable for subsequent harnesses.

- Discover models through the selected harness's supported catalog/configuration interface, never by calling model providers directly.
- Display model name/identifier and applicable harness mode or thinking setting when reported.
- Let the user explicitly choose the model used for each scheduled `Hi` kickoff.
- Apply and verify that selection on the actual kickoff session before any prompt is sent.
- Do not silently substitute a different model, account context, or API billing route.
- If the selected model disappears, is unavailable, or cannot be enforced, pause/skip the action and explain why.
- If trustworthy relative-cost or quota-impact metadata exists, show it; otherwise label cost/quota impact as **unknown**. Do not assert that a model is the cheapest based on its name.
- A model catalog entry is not proof that the model is accessible under the user's subscription.

**Acceptance criteria:** An enabled kickoff always uses the selected model or sends nothing, with the reason recorded.

### 7.4 Scheduled post-rollover `Hi` kickoff

**Priority:** P1 for Codex; capability-gated for each later harness.

**Core behavior:** After a current, verified usage-window rollover, schedule one minimal `Hi` prompt **one minute after that rollover** through the selected harness and selected model.

The app **does not reset the window**. The underlying service owns the limit and its timing. The `Hi` prompt is an initial activity in a naturally available window and consumes its applicable quota.

**Configuration:**

- Off by default, with explicit opt-in per supported harness configuration.
- User chooses the harness, a reported window (five-hour for initial Codex implementation), and an available, enforceable model.
- Default prompt is exactly `Hi`. Future editable prompt content is optional and out of scope for the first automation release.
- Before enabling, show selected harness, model, window, trigger, one-minute delay, potential quota consumption, and how to pause it.
- Provide immediate pause/stop and clear enabled/disabled state.

**Eligibility and timing:**

1. Poll or subscribe to an accepted harness usage source without consuming inference quota.
2. Compare previous and current trustworthy window snapshots.
3. Verify a real transition to a newly reported window, with fresh post-rollover data and the expected active harness context.
4. Target `confirmed provider rollover time + 60 seconds`; do not fire before a confirmed rollover.
5. Send exactly one `Hi` via the chosen harness session with the chosen model.
6. Persist a deduplication record tied to the harness, relevant window identity, and observed rollover.
7. Display the outcome separately from usage-window state.

If confirmation does not arrive in time for the scheduled action, **skip** rather than send an unverified or late catch-up prompt. If the app was closed, asleep, offline, or unable to establish the current rollover, skip and show the reason. A future bounded-grace policy can be evaluated separately; it is not a hidden default.

**Failure and safety behavior:**

- Never trigger solely because a local five-hour timer elapsed or a cached `resetsAt` timestamp passed.
- Prevent duplicate sends after restart, time-zone changes, process crashes, or repeated notifications.
- Do not blindly retry when prompt delivery might have succeeded but acknowledgement was lost.
- If model selection, harness connection, current identity, or permission state is uncertain, do not send.
- An action is `sent` only when supported acknowledgement demonstrates submission; do not equate this with a reset or completed inference.
- Keep logs of attempts, confirmed sends, skips, and failures, with no secret or conversation-content capture.
- Use a dedicated minimal session/context where supported. Do not run arbitrary tools, read project data, or modify files as part of the kickoff; reject tool permission requests. If this cannot be constrained sufficiently for a harness, defer its automation support.

**Acceptance criteria:** With automation enabled and a verifiable fresh Codex rollover, one `Hi` is submitted using the selected model no earlier than the targeted post-rollover time. For ambiguous, missed, stale, or unsupported rollovers, zero prompts are sent. Repeated signals never produce a second send.

### 7.5 OpenCode integration

**Priority:** Second harness.

- Integrate through OpenCode's documented ACP command and/or other authorized local OpenCode interfaces when required for observability.
- Discover available models and supported configuration options from OpenCode's own reported capabilities.
- Surface ACP session/turn usage, where exposed, as **session/activity usage**, not as subscription allowance.
- Research whether a supported local OpenCode interface exposes trustworthy subscription-window limits and reset timestamps for the active underlying entitlement.
- Enable rollover-based `Hi` only when that specific entitlement/window can be verified and the selected model can be enforced through OpenCode.
- Otherwise release a truthful partial integration: harness connectivity, supported model/session information, and an explicit **"subscription reset unavailable"** state.

**Acceptance criteria:** OpenCode support does not invent a universal five-hour window or treat token-context percentages as subscription usage.

### 7.6 Pi integration

**Priority:** Third harness.

- Evaluate Pi's documented local RPC interface first and ACP through a separately validated compatible adapter where useful.
- Determine whether model listing, model selection, prompt submission, local session statistics, and subscription-window data are actually available.
- Treat token/cost figures exposed by Pi as session/activity metrics unless a separate authorized source verifies subscription limits.
- Apply the common capability matrix; do not require ACP if a safer, supported Pi-local protocol better fits the task.
- Enable scheduled kickoff only if real rollover detection and selected-model enforcement can be proven.

**Acceptance criteria:** Pi is useful within its verified capability scope and clearly reports absent subscription reset data.

### 7.7 Subsequent harness integrations

**Priority:** Fourth integration wave, after Pi.

Candidate harnesses include **Claude Code, Kilo Code, Kimi Code**, and later other coding agents with suitable authorized integration surfaces.

Before committing to each integration, document:

- Maintained harness name, versions, platforms, and supported interface (native ACP, supported adapter, local SDK, CLI, or RPC).
- Whether the interface reports subscription windows, context/session usage, model choices, or prompt outcomes.
- Whether a subscribed-model route can be distinguished from API-billed or other underlying routes, where such distinction is exposed.
- Authentication prerequisite as a harness-owned condition, not an in-app credential workflow.
- Reliable rollover verification, model enforcement, prompting restrictions, errors, and fallback behavior.
- Compatibility with the application's local-only and no-direct-provider policy.

An available ACP adapter establishes a candidate integration path, **not** proof of subscription monitoring or eligibility for automation.

### 7.8 Local activity analytics (research-gated)

**Priority:** Later roadmap phase; not part of the initial integration milestones.

- Conduct a source-by-source research assessment of what Codex, OpenCode, Pi, and subsequent harnesses expose through local histories, exported metadata, and supported interfaces.
- Ask for **separate, explicit user permission** before reading local session history, workspace metadata, or files outside the current status interface.
- Prefer on-device processing, minimal structured metadata, and no transmission of conversations.
- Show source, coverage dates, model, tokens, session/project dimensions, and uncertainties only when actually present.
- Separate observed token activity, harness-computed estimates, API-equivalent estimates, and provider-reported charges.
- Defer model-level costs until price provenance, token categories, and model identity can be validated; use dated/versioned prices.
- Provide exclusion, export, deletion, and permission-revocation controls before general release.
- Never collect entire prompts or conversation bodies by default and never advertise complete account-level statistics based on partial local logs.

**Acceptance criteria:** Analytics cannot be enabled without a clear permission action, and each chart exposes source coverage and limitations.

### 7.9 Multiple accounts (final phase only)

- Do not build account switching or multi-account automation as a prerequisite for Codex, OpenCode, Pi, or analytics research.
- The near-term product targets the **currently active harness identity/configuration** only.
- Eventually evaluate harness-supported, isolated profiles; retain all account and credential ownership inside the harness.
- Require independently verified account targeting and independent opt-in before any multi-account kickoff.
- Never silently switch identities or infer separate account access from a harness that exposes only one active login.

### 7.10 Desktop widget and notifications

- Retain the existing macOS WidgetKit extension with snapshots from implemented harnesses.
- Show usage and freshness concisely; omit or label unsupported values.
- Users add widgets from the macOS gallery. The app neither installs nor detects placement of the widget.
- Optional local reset reminders do not initiate model inference or consume quota.
- Windows and Linux features, including widgets, require independent research and test evidence.

## 8. Proposed architecture

The application architecture consists of four layers:

**Tauri desktop UI**

- Harness overview, usage and reset windows.
- Per-harness model picker and kickoff controls.
- Automation history and status.
- Later: permissioned local analytics.

**Rust application core**

- Harness discovery and capability registry.
- Read-only status polling, freshness, and normalization.
- Verified rollover detector.
- Local, durable once-per-rollover scheduler and audit log.
- Session/model/prompt executor, explicitly enabled only.
- Later: permissioned local analytics importers.

The packaged Rust process is named `agentgauge-daemon` for clear identification
in process listings. It hosts the desktop app and its background polling; it is
not a separately installed operating-system service.

**Harness adapters (no direct model-provider APIs)**

- Codex adapter: existing app-server integration.
- OpenCode adapter: ACP and supported local visibility surface.
- Pi adapter: RPC and/or validated ACP adapter.
- Later: Claude Code, Kilo Code, Kimi Code, and others.

**User-installed, user-authenticated coding harnesses**

- Own their configured providers, plans, models, and credentials.

### 8.1 Adapter contract (conceptual)

Each adapter independently declares whether it supports:

- `discover` / `connect` / `getHarnessInfo`
- `getUsageWindows` and snapshot provenance
- `getModels` and `selectModelForSession`
- `createMinimalSession` / `sendKickoffPrompt`
- `getActionOutcome` when reliably observable
- `readLocalActivityMetadata` only under an additional permission

Adapters must never supply a fake success response or fake values for unsupported methods. A capability can be `supported`, `unsupported`, `unverified`, or `temporarily_unavailable`.

### 8.2 Data semantics

Usage-window records must carry, when present: harness, source interface, active context identifier, limit/window type, native units, used/remaining meaning, reported reset time, read time, and freshness. Unsupported fields stay null/unknown.

Kickoff records must carry: harness, selected model, targeted window/rollover identity, scheduled time, attempt time, outcome, and failure/skip reason. Never store unnecessary prompt content or secrets.

### 8.3 Technical boundaries

- The Rust backend owns polling, subprocess/ACP/RPC interactions, scheduler state, and persistence; the renderer does not independently dispatch quota-consuming actions.
- No mandatory cloud service is required.
- Use documented interfaces and explicit process lifecycle management; bound polling and subprocess resource usage.
- Guard against clock changes with persisted source times and durable action IDs.
- Treat OS/app suspension as a reason to reassess eligibility, not replay old actions.

## 9. Reliability, privacy, and safety requirements

- Preserve source and capture timestamps across adapter, Rust core, IPC, UI, and widget.
- Classify readings as `live`, `cached`, `stale`, `unavailable`, or `unsupported`; retain a human-readable reason.
- Never let one harness's failure wipe another harness's last reliable reading.
- Never show a nonexistent entitlement, limit, model selection, or reset as confirmed.
- Keep provider credentials wholly in user-managed harnesses; AgentGauge never asks for or stores them. Avoid logging sensitive values that might appear in harness diagnostics.
- All inference-consuming automation is opt-in and can be paused immediately.
- No silent model fallback, unexpected account switching, unbounded retries, or catch-up sends.
- Analytics requires a separate permission path with explicit scope, local retention/deletion rules, and no automatic uploads.
- Verify supported operating systems with actual tests; macOS is the only verified platform at this stage.

## 10. Phased roadmap and release gates

### Phase 0 - Codex monitoring foundation (existing; harden)

- Stabilize Codex app-server usage reads, five-hour/weekly windows, freshness, and widget behavior.
- Validate active-context detection and candidate `resetsAt` transitions.
- Clearly mark unsupported fields and existing manual ping behavior.
- Document what is shipped versus planned.

**Gate:** Accurate Codex-only status; no automatic prompts.

### Phase 1 - Codex model selection and post-rollover kickoff

- Add harness-reported model discovery and a user model picker.
- Validate selected-model application on a minimal Codex session.
- Strengthen verified rollover detection and persistent once-per-rollover deduplication.
- Implement one `Hi` prompt at the eligible verified rollover plus one minute.
- Add enable/pause, reset timeline, audit log, skip/failure reasons, and offline handling.
- Keep the feature off by default.

**Gate:** Demonstrably correct model targeting, zero duplicates, zero early/unverified sends.

### Phase 2 - OpenCode integration

- Implement ACP connectivity and model/session capability discovery.
- Research and implement any authorized local status interface necessary for subscription visibility.
- Show honest partial capability states.
- Reuse kickoff only for verifiable supported windows and selectable models.

**Gate:** OpenCode is integrated within demonstrated capabilities; unsupported subscription stats are not guessed.

### Phase 3 - Pi integration

- Evaluate and integrate Pi's supported local RPC capabilities and optional maintained ACP adapters.
- Normalize model choice, session information, and available usage metadata.
- Implement reset monitoring and kickoff only if Pi exposes verifiable window semantics through an acceptable path.

**Gate:** Working, documented Pi integration with a completed capability report.

### Phase 4 - Additional coding harnesses

- Evaluate Claude Code, Kilo Code, Kimi Code, then other qualified harnesses.
- Prioritize maintained documented ACP support or comparably safe local interfaces.
- Deliver adapters only to the extent their capabilities are verified.

**Gate:** Each added harness has documented support limitations, platform verification, and regression tests.

### Phase 5 - Permissioned local analytics

- Research usable metadata/history sources and permission requirements.
- Prototype on-device activity summaries with coverage and exclusions.
- Add versioned API-equivalent estimates only after validation.
- Implement export, deletion, and permission revocation.

**Gate:** Clear user consent, defensible calculations, and visible incomplete-data caveats.

### Phase 6 - Multi-account support (last)

- Research supported harness-owned account profiles and isolation.
- Introduce independently identified active contexts without managing provider credentials.
- Add per-profile views and separately authorized kickoffs only when targeting is proven.

**Gate:** No cross-profile actions, no silent identity changes, and durable account-scoped deduplication.

## 11. Success metrics

- **Monitoring quality:** Percentage of refreshes with trustworthy source/freshness metadata; reduction in misleading or unexplained unavailable states.
- **Integration quality:** Number of implemented harness adapters with documented capability coverage and tests, not merely number of names displayed.
- **Kickoff correctness:** Eligible rollovers with exactly one successful submission; early-send, duplicate-send, and wrong-model events should be zero.
- **Automation transparency:** Every attempted, skipped, or failed action has an inspectable reason and timestamp.
- **User control:** Users can reliably disable scheduled actions and verify current enablement.
- **Analytics trust (later):** Every analytics view exposes provenance and coverage; opt-in, deletion, and revocation behave as documented.

Do not optimize for increasing quota consumption or maximizing prompts sent.

## 12. Key risks and unresolved technical questions

1. **Reset visibility beyond Codex:** ACP session usage does not inherently provide subscription windows. What supported harness-specific data, if any, exposes them in OpenCode, Pi, and later integrations?
2. **Model-to-entitlement mapping:** Can a model chosen in a multi-provider harness be associated with the intended subscription route, rather than an unexpected API-billed route?
3. **Model enforcement:** Can the selected model be bound to the exact kickoff session and verified before sending?
4. **Rollover confirmation latency:** Can source polling reliably establish a new window before the one-minute target? If not, a missed kickoff is preferable to an unverified send.
5. **Minimal-session isolation:** Can a `Hi` turn be run without unintended project access or tool execution for each harness?
6. **Pi ACP maturity:** Which maintained adapter is sufficiently compatible, or is Pi's native RPC the preferred supported integration?
7. **Local analytics permission:** What data is exposed, what requires filesystem permission, and what should be excluded by default?
8. **Platform behavior:** How do process lifecycle, background execution, and sleep affect scheduling on each target OS?

These are implementation feasibility questions, not reasons to change the selected roadmap order.

## 13. Product decisions recorded

| Decision                       | Resolution                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| Primary scope                  | AI coding **harnesses**, not direct model-provider platforms.                      |
| Authentication and credentials | Owned entirely by installed harnesses; no credential entry or storage in this app. |
| Integration order              | **Codex → OpenCode → Pi → Claude Code/Kilo Code/Kimi Code/others.**                |
| Core automation                | Optional `Hi` kickoff after each eligible, verified reported rollover.             |
| Kickoff timing                 | Target one minute after confirmed rollover; skip missed/unverifiable actions.      |
| Model choice                   | **User selects** a harness-reported model; enforce selection or skip.              |
| Consumption                    | `Hi` consumes quota, and does not cause/reset/extend the usage window.             |
| Analytics                      | Later phase; requires independent research and explicit user permission.           |
| Multiple accounts              | **Final phase only.**                                                              |
| Initial target environment     | macOS; other operating systems require verification.                               |

## 14. Definition of ready for development

An individual harness feature is ready for implementation when its proposal identifies:

- The specific documented local harness interface and supported versions.
- The precise source and meaning of every displayed field.
- The current authenticated harness context (without reading credentials).
- Whether real subscription reset semantics are available.
- How supported models are discovered, selected, and enforced.
- How a scheduled `Hi` will be safely dispatched and observed, if eligible.
- Expected unavailable/unsupported/error states and tests.
- Operating systems on which the behavior has actually been verified.

A provider/harness name in this PRD is a **priority or feasibility candidate**, not evidence of shipped support.

## 15. Technical references (research context; not implementation claims)

- [Agent Client Protocol: overview](https://agentclientprotocol.com/protocol/v1/overview) - general agent/client interoperability; no universal guarantee of subscription-limit telemetry.
- [ACP session config options](https://agentclientprotocol.com/protocol/v1/session-config-options) - supported session settings, including model options where exposed.
- [OpenCode ACP documentation](https://opencode.ai/v2/docs/cli/acp/) - documented ACP process, model configuration, prompt execution, and usage updates.
- [Pi coding agent repository](https://github.com/earendil-works/pi) - Pi's local RPC/SDK surface; adapter compatibility is a separate validation task.
- [Kilo Code CLI documentation](https://kilo.ai/docs/code-with-ai/platforms/cli) - documents `kilo acp` and local model/statistics commands.
- [Kimi Code CLI ACP documentation](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp) - documents `kimi acp` and model/session-related capabilities.
- [Claude Code ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp) - potential adapter route, subject to terms and behavioral verification.
- [Codex app-server](https://github.com/openai/codex/tree/main/codex-rs/app-server) - existing local integration surface for Codex.

---

**README update rule:** After adopting this PRD, the top-level README should lead with the harness-first vision and integration priority, then clearly list **Codex-only current functionality** and label all other harnesses, automated kickoff, model selection, analytics, and multi-account support as planned or under investigation.
