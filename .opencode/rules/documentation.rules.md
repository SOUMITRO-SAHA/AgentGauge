# Documentation & Comment Rules (canonical — all languages, binding)

This file is the **single source of truth** for source-code comments and
documentation across the monorepo. Every other rule file and `AGENTS.md`
references it; none duplicates it. When this file conflicts with any other
instruction, this file wins.

Core principle:

> **The code should explain the implementation. Documentation should explain
> the contract and the context.** Do not write comments that translate code
> into English. If better code can eliminate the need for a comment, improve
> the code first.

---

## The hierarchy

When code is hard to understand, fix it in this order before reaching for a
comment:

```
clear names
  ↓
strong types
  ↓
small focused functions
  ↓
clear control flow
  ↓
good abstractions
  ↓
native API documentation where useful
  ↓
rare explanatory comments (the exception, never the default)
```

**Never narrate the _what_.** If the implementation already communicates the
operation, no comment is required — and one is not merely unneeded, it is
noise. Comments like these must not exist:

```
increment the counter        create the client        call the API
check the result             return the response      loop through items
parse the JSON               serialize the payload    start the server
stop the process             create the directory     read the environment variable
handle the error             set the flag             get the user
```

A narrating comment on a line that follows directly from good names is worse
than no comment: it doubles the reading surface and goes stale silently.

## Prefer refactoring over commenting

If code needs prose to be understood, first try: renaming a
variable/function/type/constant to carry the domain term, tightening a type
or introducing an existing domain abstraction, extracting a function,
simplifying a condition, or splitting a module. Example:

```ts
// Before
// Check whether this error can be retried.
if (check(error)) {

// After
if (retryPolicy.canRetry(error)) {
```

Do **not** perform artificial abstraction merely to remove a harmless line.
Judgment applies; the principle is that better code beats explanation.

## Documentation vs. narration

API documentation and implementation comments are different tools.

**Native doc comments** document **contracts** callers cannot read from the
signature: behavior, side effects, error semantics, failure behavior,
ownership, lifecycle, thread-safety/concurrency, ordering guarantees,
idempotency, retry semantics, security/privacy requirements, units, valid
ranges, backward compatibility, caller obligations, performance implications.

```rust
// Good — states a guarantee the signature cannot:
/// Persists the batch before acknowledging its queue entries.
///
/// Returning `Ok` guarantees that the database transaction committed.

// Bad — restates the name:
/// Persists a batch.
fn persist_batch(...)
```

**Do not duplicate type information.** In typed languages never document
`@param userId string` / `@returns Promise<void>` — the signature already
says it. Document semantic meaning instead ("Maximum time to wait before
abandoning the flush." adds information).

**Do not pursue coverage.** The objective is documentation _quality_, not
quantity. Never add boilerplate doc comments to every symbol; private
helpers whose names already say everything stay undocumented.

## Public API surfaces

These are the externally consumed / cross-package boundaries — document
their exports with the native convention when the export carries a real
contract:

- `packages/api-client` (`src/index.ts` is the public surface)
- `packages/shared` and `packages/ui` (exported types, helpers, components)
- `packages/admin-client` (service, methods, wire types, guard-rail consts)
- Server HTTP contracts (`apps/server` routes) and MCP hub tools
  (`apps/mcp_server`) — documented at the route/tool level and in
  `apps/server/auto_testing/endpoints/*.md` + `postman/README.md`, not by
  duplicating prose inside handlers
- CLI/script entry points (`auto_testing/run.sh`, `scripts/*.sh`,
  `deploy.sh`) — document usage and required inputs at the top

Interior implementation is **not** over-documented: a private helper needs a
doc comment only when its name cannot carry the contract.

## A plain implementation comment

Ordinary `//`-style comments are allowed **only** for a non-obvious _why_:

- security requirements and threat-model constraints
- protocol/vendor/platform workarounds and compatibility constraints
- ordering invariants and concurrency assumptions
- counterintuitive performance decisions
- non-obvious failure semantics

Even then, first ask whether the information belongs in a better abstraction,
API documentation, module documentation, a test name, `tasks/context/` /
`docs/`, or a README — and use a source comment only when the source is
genuinely the best location.

Language-specific required forms are preserved (see "Required comments"
below): Rust `// SAFETY:` blocks, clippy/rustc allow explanations, "why this
`unwrap` is unreachable" notes per `.agents/rules/rust.md`.

## Architecture explanations live outside source files

Why a technology was chosen, deployment topology, security architecture,
release strategy, service boundaries, migration strategy — these belong in
`docs/`, `tasks/context/`, README files, or ADRs. Source comments stay local
to the code they describe. Never embed long architectural essays in a source
file.

## Tests

Tests follow the same standard: expressive names over explanatory comments.

```
// Good name — no narration needed:
does not acknowledge the message before the transaction commits

// Bad:
renders correctly   // should show the list; checks the item count
```

No ritual `Arrange / Act / Assert` banners unless a suite's established
convention genuinely aids readability. Extract test helpers when setup gets
hard to follow. The binding test workflow lives in
[`.agents/rules/testing.md`](testing.md).

## Configuration, infrastructure, and non-source files

Prefer descriptive names over comments in every config surface: Makefile
targets, `turbo.json` tasks, GitHub/CI steps, `docker-compose*.yml` service
names, `dprint.json`/`bunfig.toml` keys, Postman request names. A step named
`Authenticate to AWS with OIDC` needs no `# Authenticate to AWS.` above it.

Comments in configuration are appropriate only for non-obvious reasons,
constraints, or platform behavior (e.g. why a flag is pinned, why a compose
file deliberately references prod env).

- Shell scripts: sparse rationale comments; document usage/inputs at the top.
- SQL migrations: comment only schema decisions a reader cannot infer
  (backfill caveats, lock-safety notes).
- `postman/` workspace YAML: never hand-author beyond the keys the root
  `AGENTS.md` lists as safe — request-level comments/scripts are
  app/MCP-managed.

## TODO / FIXME

Vague markers are not allowed: bare `TODO`, `FIXME`, `HACK`, `XXX`, `TEMP`,
`WIP` are removed on sight. A retained `TODO` must name the actionable
unresolved issue and its trigger condition, e.g.
`// TODO(<task_id>): remove the v1 envelope once every client ships v2.`
Work that is in scope right now gets done, not TODO'd. Stale TODOs are
deleted when touched. Larger deferred work belongs in `tasks/TODO.md`, not
in comments.

## Never keep

- **Commented-out code** — version control keeps history; delete it. The
  only exception is a concrete, current, unusual reason (e.g. a
  platform-bug reproduction kept deliberately), which must be stated in the
  surrounding comment.
- **Temporary/debug notes** — `debug`, `temporary`, `works now`, `try this`,
  `revisit later`, `don't know why`, `test this`.
- **Section banner noise** (`// ===== Helpers =====`) — organize files
  instead. Use a marker only where it measurably aids navigation in an
  otherwise unsplit-able file.
- **Historical commentary** — "previously this used X", "added by …",
  "changed after the bug", "generated by ChatGPT/Claude". Git history owns
  attribution; ADRs own architectural history. Keep historical context only
  when it explains a compatibility requirement that still exists.

## Required comments — never delete blindly

Preserve and keep accurate: license/copyright headers, generated-code
markers, compiler/linter/formatter directives (`#[allow(...)]` with reason,
`// oxlint-disable-next-line <rule>: <why>`, `// ignore_for_file: ...`,
`// deno-lint-ignore`, etc.), coverage directives, `// SAFETY:` blocks,
feature/permission requirement notes, and platform-required annotations.
Verify each suppression is still necessary; never add one just to silence
tooling.

## Generated code — do not hand-edit

Never manually clean comments in generated output:

- `apps/web-extension` TanStack `routeTree.gen.ts`
- `apps/libryva` `*.g.dart`, `*.freezed.dart` (drift/riverpod/freezed)
- lockfiles, build outputs, `node_modules`, `.turbo`, vendored/reference
  trees (`.agents/references/`)

If generated comment quality needs improving, change the generator or the
source schema.

## AI agents — binding

- **Never add comments merely because generated code looks more complete
  with them.**
- Before writing an implementation comment, attempt to make the
  implementation self-explanatory through naming, types, decomposition,
  domain modeling, and clear control flow.
- When modifying existing code, do not preserve redundant comments simply
  because they already exist — remove narration you touch.
- Do not produce boilerplate documentation for every symbol.
- Whenever behavior changes, verify surrounding comments still describe the
  code: a stale comment is worse than none.

The default is **NO COMMENT** unless documentation adds real information.

## The decision test

Run every prospective comment through this:

```
Is the comment describing WHAT the code does?
  → Do not add it.

Could better naming, typing, or decomposition remove the need?
  → Refactor where appropriate.

Is this a public API contract consumers need?
  → Use the language's native doc-comment format (below).

Is this a critical invariant, security requirement, compatibility
constraint, workaround, or non-obvious reason?
  → Document it concisely, in the most appropriate location.

Is the comment required by a compiler, tool, generator, legal
requirement, or safety convention?
  → Preserve it.

Otherwise:
  → Do not add the comment.
```

## Native documentation conventions by language

| Language / surface                       | Convention                                                       |
| ---------------------------------------- | ---------------------------------------------------------------- |
| TypeScript / JavaScript (all apps, pkgs) | JSDoc `/** … */` on exported symbols with real contracts         |
| Rust (`apps/server`)                     | rustdoc `///` on public items, `//!` for module docs             |
| Dart / Flutter (`apps/libryva`)          | dartdoc `///` on public members/classes                          |
| Astro (`apps/website`)                   | JSDoc on exported TS config/helpers; `.astro` markup stays clean |
| Shell scripts                            | usage header + sparse rationale `#` comments                     |
| SQL migrations                           | sparse, decision-only                                            |
| Docker / Makefile / turbo / CI YAML      | descriptive names; comments only for constraints                 |
| Markdown (`docs/`, READMEs)              | prose rules in [`../docs/AGENTS.md`](../../docs/AGENTS.md)       |

Language rule files ([`rust.md`](rust.md), [`typescript.md`](typescript.md),
[`naming-convention.md`](naming-convention.md)) carry only their
ecosystem-specific additions on top of this file.
