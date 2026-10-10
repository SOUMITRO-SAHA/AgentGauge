# Code Review Rules

Binding policy for every code review in this repo — human or agent. Gates are
the local commands in [`testing.md`](testing.md); the five shell integration
points and the e2e build constraint are in [`tauri.md`](tauri.md).

## Conduct

- A review is **read-only**. Never edit, refactor, or format source while
  reviewing. Fixes happen only in a follow-up task the user approves.
- Never read, print, or echo any `.env*` file, credential, or key during a
  review (see [`security.md`](security.md)).
- Recommendations requiring a **new dependency, toolchain change, or infra
  change** are approval-gated: put them in a dedicated report section; never
  install or add anything to prove a finding.
- Ground every finding in the repo as it exists at review time. Re-read the code
  path before flagging — no findings from memory, docs, or stale context.
- Never describe provider integrations, monitoring, automation, or widget
  behavior as implemented unless the code implements it (`AGENTS.md`). The app
  is still the starter greeting example — do not review against an imagined
  product.

## Evidence

Every finding carries:

1. `file:line` — a project-relative path.
2. The quoted offending code.
3. The rule violated — cite the exact file and section (`.opencode/rules/*.md`,
   `AGENTS.md`) or the external practice it breaks.
4. Impact: what breaks, when, for whom.
5. A concrete, minimal fix (no redesigns unless the defect is structural).

No location or no rule citation ⇒ it is an opinion, not a finding. Put opinions
in a separate "Notes" section.

## Review priorities for this repo

Check these first — they are the highest-risk surfaces here:

1. **Capabilities / permissions** (`src-tauri/capabilities/*.json`) — any
   widening, wildcard, or release-build exposure of the wdio plugins is
   Critical.
2. **IPC boundary** — commands without input validation, secrets crossing into
   renderer state, unbounded inputs, missing error typing.
3. **Effect discipline** (client) — `async`/`await` or `try`/`catch` inside
   Effect code; an unhandled `AsyncResult` branch in a component; `any` or
   `@ts-expect-error` papering over an `R`/`E` channel; an atom holding a
   secret; `Date.now()` in logic that should take an injected clock; a
   `Layer.provide` where `provideMerge` was meant (or vice versa).
4. **Rust tier boundaries** — an import that points upward
   (`shared/` → `modules/`), a sideways sibling-module import, or a crate that
   needs `agentgauge-daemon`/`tauri` to build. See [`rust.md`](rust.md).
5. **Data honesty** — a usage/status value rendered without provenance or
   freshness; a `?? 0` / `-` placeholder that reads as real data; a nullable
   field instead of the four-state union; `waiting: true` shown as a fresh
   reading.
6. **The five e2e integration points** — a change that silently breaks the
   harness (plugin registration moved out of `debug_assertions`, capability or
   `withGlobalTauri` change, `custom-protocol` removed).
7. **Rust correctness** — `unwrap`/`expect` on reachable paths, a lock guard
   held across `.await`, `cargo clippy -D warnings` noise.
8. **Testing policy** — a UI change without an e2e spec, or with a gate that
   was claimed but not run. See [`testing.md`](testing.md) and `AGENTS.md`.
9. **Dependency / lockfile drift** — a manifest change without the matching
   `bun.lock` / `Cargo.lock` update; a version younger than the 15-day gate; the
   Effect exact pins loosened into a range or a dist-tag.

## Severity

| Level    | Meaning                                                                    | Triage                   |
| -------- | -------------------------------------------------------------------------- | ------------------------ |
| Critical | Exploitable security flaw, credential/secret exposure, data loss            | Fix before next release  |
| High     | Correctness bug users will hit; broken e2e/CI gate; data shown wrongly      | Fix before merge         |
| Medium   | Rule violation without immediate breakage; perf waste on a hot path         | Fix next task            |
| Low      | Style/consistency drift, missing docs, dead code                           | Batch fix                |
| Nit      | Optional polish                                                            | Fix if touching the file |

False-positive guard: a finding stands only after re-reading the surrounding
code and its tests. Documented invariants are accepted — flag them only if the
justification is wrong or missing.

## Report

- Write the report as your response by default. Only create a file when the user
  asks; if you do, put it in `.temp/reviews/<scope>-YYYY-MM-DD.md` (kebab-case,
  `-2` suffix for a second run the same day). **Nothing under `.temp/` is
  committed.**
- Report order: header (date, commit, scope, gates run) → gate results →
  findings grouped Critical→Nit → approval-gated recommendations → notes →
  top-3 actions.
- If a gate could not be run, say so explicitly rather than implying the change
  is clean.
