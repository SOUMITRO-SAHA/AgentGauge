# Code Review Rules

Binding policy for every code review in this repo — human or agent. The `server-review` skill implements this for `apps/server`; any new review skill for another app must follow the same policy.

## Conduct

- A review is **read-only**. Never edit, refactor, or format source while reviewing. Fixes happen only in a follow-up task the user approves.
- Never read or write any `.env*` file during a review (see `apps/server/AGENTS.md` critical rules).
- Recommendations that require a new dependency, toolchain change, or infra change are **approval-gated**: list them in a dedicated report section; never install or add anything to prove a finding.
- Ground every finding in the repo as it exists at review time. Re-read the code path before flagging — no findings from memory, docs, or stale context.

## Evidence

Every finding carries:

1. `file:line` location (project-relative path).
2. Quoted snippet of the offending code.
3. The rule violated — cite the exact file and section (`.agents/rules/*.md`, `apps/*/AGENTS.md`) or the external practice it breaks.
4. Impact: what breaks, when, for whom.
5. Recommended fix (concrete, minimal — no redesigns unless the defect is structural).

No location or no rule citation ⇒ not a finding; it is an opinion. Put opinions in a separate "Notes" section.

## Severity

| Level    | Meaning                                                                   | Triage                   |
| -------- | ------------------------------------------------------------------------- | ------------------------ |
| Critical | Exploitable security flaw, data loss/corruption, auth bypass              | Fix before next deploy   |
| High     | Correctness bug likely to hit production; resource exhaustion (pool, mem) | Fix this week            |
| Medium   | Rule violation without immediate breakage; perf waste on hot paths        | Fix next task            |
| Low      | Style/consistency drift, missing docs, dead code                          | Batch fix                |
| Nit      | Optional polish                                                           | Fix if touching the file |

False-positive guard: a finding stands only after re-reading the surrounding code and its tests. Documented invariants (e.g. `expect("HMAC accepts any key length")`) are accepted — flag them only if the justification is wrong or missing.

## Report

- Reviews write their report to `tasks/reports/<app>-review-YYYY-MM-DD.md` (kebab-case; `-2` suffix on a second run the same day). Nothing under `tasks/` is committed.
- Report order: header (date, commit, scope, gates run) → gate results → findings grouped Critical→Nit → approval-gated recommendations → notes → top-3 actions.
- The review run itself follows the task-registry lifecycle in the monorepo `AGENTS.md` (claim → done → move to `tasks/completed/`).
