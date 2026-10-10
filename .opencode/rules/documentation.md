# Documentation & Comment Rules

Canonical, binding for comments and documentation across the repo — Rust,
TypeScript/React, config, and the e2e suite. Other rule files reference this
one; none duplicates it. **When this file conflicts with another instruction,
this file wins.**

Core principle:

> **The code should explain the implementation. Documentation should explain
> the contract and the context.** Do not write comments that translate code
> into English. If better code removes the need for a comment, improve the code
> first.

The default is **no comment**. This file is strict by design:

1. **Inline comments are forbidden by default** — written only when genuinely
   critical, never because they feel thorough.
2. **Exactly two documentation formats exist** — JSDoc for TypeScript, rustdoc
   for Rust. Nothing else is documentation.
3. **Commit messages follow one standard** — the standard commit convention.
   No free-form subjects.

## The hierarchy

When code is hard to understand, fix it in this order before reaching for a
comment:

```
clear names → strong types → small functions → clear control flow
  → good abstractions → native API docs → rare explanatory comments (the exception)
```

**Never narrate the _what_.** If the implementation already communicates the
operation, a comment is not merely unneeded — it is noise, it doubles the
reading surface, and it goes stale silently. These must not exist:

```
increment the counter   create the client   call the API   return the response
parse the JSON          set the flag       handle the error   loop through items
read the environment variable   start the server   stop the process
```

## Prefer refactoring over commenting

```ts
// Before — narration
// Check whether this error can be retried.
if (check(error)) {

// After — the name is the comment
if (retryPolicy.canRetry(error)) {
```

Rename to carry the domain term, tighten a type, extract a function, simplify a
condition, split a module. Do **not** add artificial abstraction just to delete
a harmless line — judgment applies; better code beats explanation.

## Native docs document contracts

Doc comments document what the **signature cannot**: behaviour, side effects,
error semantics, ownership, lifecycle, concurrency, ordering, idempotency,
retry behaviour, security/privacy requirements, units, valid ranges, caller
obligations, performance implications.

```rust
// Good — a guarantee the signature cannot express:
/// Returns `Ok` only after the usage snapshot has been written to the cache.

// Bad — restates the name:
/// Persists a batch.
```

- **Never duplicate type information.** Not `@param name string`, not
  `@returns Promise<void>` — the signature says that. Document meaning instead
  ("Maximum time to wait before abandoning the refresh" adds information).
- **Do not pursue coverage.** Quality, not quantity. A private helper whose name
  says everything stays undocumented. No boilerplate on every symbol.

**Exactly two documentation formats exist in this repo — nothing else:**

- **Rust: rustdoc only.** `///` on items, `//!` for module docs. No other
  comment form documents a symbol.
- **TypeScript/React: JSDoc only.** `/** … */` on exported symbols that carry a
  real contract — a discriminated union's variants, an IPC wrapper's error
  behaviour, an atom's state machine, a hook's return shape. Not on
  self-evident components.

Anything else — `//` doc lines, banner blocks, ad-hoc markdown beside the code,
third-party doc syntax — is not documentation and must not be written. On
review it is removed on sight.

## Inline `//` comments — forbidden by default

Inline `//` comments are **not written**. Not "sparingly", not "when helpful" —
never as a default. If code needs a `//` to be understood, that is a refactor
signal: rename, retype, decompose, or move the fact into a doc comment, a test
name, or `docs/`.

The single exception is a comment whose absence would risk real damage —
genuinely important, not merely polite:

- `// SAFETY:` justifications for `unsafe`
- non-obvious platform/vendor workarounds that no refactor can express
- security requirements and threat-model constraints
- ordering invariants and concurrency assumptions the compiler cannot check

Even for these, first check whether a stronger type or a better abstraction can
carry the fact instead. When one is truly warranted it is rare, concise, and
states the _why_. If you are writing one because it feels thorough or
complete, delete it.

## Required comments — never delete blindly

Preserve and keep accurate: license/copyright headers, generated-code markers,
`#[allow(...)]` with a reason, `// SAFETY:` blocks, feature/permission
requirement notes, and platform-required annotations
(`#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` in
`main.rs`). Verify each suppression is still necessary; never add one just to
silence tooling.

This repo already uses the right pattern — keep it. The comments explaining the
wdio plugin/debug-build tension in `Cargo.toml`, `tauri.conf.json`, and
`e2e/wdio.conf.ts` are exactly the non-obvious *why* this file asks for.

## Architecture belongs outside source files

Why a technology was chosen, platform support status, security architecture,
release strategy, provider-integration design — these belong in `README.md`,
`AGENTS.md`, or `docs/`. Source comments stay local to the code they describe.
Never embed an architectural essay in a source file.

## Commit messages — the one standard

Every commit message follows the standard commit convention. No free-form
subjects, no generated summaries:

```
type(scope): imperative subject
```

- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
  `ci`, `chore`, `revert`.
- `scope` is optional; when present it names the touched area (`widget`,
  `polling`, `ui`, `deps`, `e2e`, …).
- Subject: imperative mood, lowercase after the colon, no trailing period.
- Body (optional): blank line after the subject; explains **why**, not what.
- Breaking change: `!` before the colon (`feat!:`) plus a `BREAKING CHANGE:`
  footer.

Never append "Generated with …" or attribution footers, never paste a diff or
task log into the message, and never let prose replace the `type: subject`
header. A change that cannot be described in this format is doing too much —
split it.

## Tests and specs

Expressive names over explanatory comments. Tests follow the same standard as
production code.

```
// Good name — no narration needed:
does not render a usage value without its fetch time

// Bad:
renders correctly   // should show the list; checks the item count
```

No ritual `Arrange / Act / Assert` banners unless the suite's convention
genuinely aids readability. See [`testing.md`](testing.md).

## Config, infra, and non-source files

Prefer descriptive names over comments in every config surface: script names,
Tauri window/plugin entries, cargo features, `bunfig.toml` keys, CI steps. A
step named "Install dependencies" needs no `# Install dependencies` above it.
Comments in config are appropriate only for non-obvious reasons, constraints,
or platform behaviour.

- Config files: sparse rationale comments; document usage/inputs at the top of
  scripts (`app/scripts/*.ts`).
- Lockfiles, `bun.lock`/`Cargo.lock`, and build output: never hand-edited, never
  hand-commented.

## TODO / FIXME

Vague markers are removed on sight — bare `TODO`, `FIXME`, `HACK`, `XXX`,
`TEMP`, `WIP`. A retained `TODO` must name the actionable issue and its
trigger — and is one of the only sanctioned inline comments in this repo:

```
// TODO(<task_id>): remove the v1 usage payload once every provider ships v2.
```

Work that is in scope now gets done, not TODO'd. Stale TODOs are deleted when
touched. Larger deferred work belongs in the task notes, not in comments.

## Never keep

- **Commented-out code** — version control keeps history; delete it. The only
  exception is a deliberate, current, unusual reason (e.g. a platform-bug
  reproduction), stated in the surrounding comment.
- **Temporary/debug notes** — `debug`, `temporary`, `works now`, `try this`,
  `revisit later`, `don't know why`, `test this`.
- **Section banner noise** (`// ===== Helpers =====`) — organize the file
  instead.
- **Historical commentary** — "previously this used X", "changed after the
  bug", "generated by …". Git owns attribution. Keep history only when it
  explains a compatibility requirement that still exists.

## Effect code

Effect has its own comment conventions, and they differ from ordinary React
code — follow [`effect.md`](effect.md) for the patterns.

- **No `async`/`await` and no `try`/`catch` inside Effect code.** If you feel
  the need for either, the abstraction is wrong — restructure rather than
  reaching for a comment.
- `Effect.fn("ServiceName.operation")` names the span, so the name is the
  documentation. Do not also add a comment saying what it does.
- Comment the *why* when changing a channel only under the critical-exception
  bar: why a service now requires `Scope`, why `Layer.provide` was chosen over
  `provideMerge`, why an effect is `uninterruptible`. These are concurrency and
  layering semantics the type system cannot express — genuinely important, and
  rare.
- Document an exported `Schema` with a one-line contract about what it accepts
  and what it rejects. Do not restate the field types.
- Never paste Effect source into a comment to explain an API — link the
  reference clone (`.agents/references/effect`) or the docs instead.

## Generated code — do not hand-edit

Never manually clean comments or reformat generated output:

- `app/src/components/ui/*` — vendored shadcn/ui upstream code
- `app/src-tauri/gen/schemas/**` — Tauri capability schemas (git-ignored)
- lockfiles, `app/dist`, `app/src-tauri/target`, `node_modules`

If generated comment quality needs improving, change the generator or the
source schema.

## AI agents — binding

- **Never add comments because generated code looks more complete with them.**
- **Never write an inline `//` comment by default.** Only the critical cases
  this file allows — safety, security, workarounds, unchecked invariants — and
  only when nothing else can carry the fact.
- **The documentation format is not a choice:** JSDoc for TypeScript, rustdoc
  for Rust, nothing else.
- **Commit messages follow the standard commit convention** — never free-form,
  never tool-generated footers.
- Before writing an implementation comment, try to make the implementation
  self-explanatory through naming, types, decomposition, and control flow.
- When modifying code, do not preserve a redundant comment just because it
  already exists — remove narration you touch.
- Do not produce boilerplate documentation for every symbol.
- When behaviour changes, verify surrounding comments still describe the code: a
  stale comment is worse than none.

## The decision test

```
Describing WHAT the code does?              → Do not add it.
Could naming/typing/decomposition remove it? → Refactor.
A public API contract consumers need?      → Native doc comment — JSDoc or
                                             rustdoc, the only two formats.
A critical safety, security, workaround, or unchecked-invariant note nothing
else can carry?                            → Concise inline comment, rare.
Any other inline `//`?                     → Do not add it.
Required by a compiler, tool, generator, or convention?
                                           → Preserve it.
Otherwise                                  → Do not add it.
```

Language-specific additions live in [`rust.md`](rust.md),
[`typescript.md`](typescript.md), and [`ui.md`](ui.md).