# Effect Rules

Binding on **all client TypeScript and React** in `app/src`, `app/e2e`, and
`app/scripts`. Effect is not optional here: data access, async work, error
handling, and state all go through it. Rust is unaffected
([`rust.md`](rust.md)).

## Version (pinned, exact)

| Package                | Version              | Why this line                                        |
| ---------------------- | -------------------- | ---------------------------------------------------- |
| `effect`               | `4.0.0-beta.107`     | The newest v4 that satisfies the 15-day gate (60 days old). `4.0.0` stable is 8 days old and blocked — it would resolve to v3, which has no Atom/React story at all. |
| `@effect/atom-react`   | `4.0.0-beta.107`     | React bindings; same line, must match `effect` exactly. |
| `@effect/vitest`       | `4.0.0-beta.107`     | Test helpers; same line.                              |

Pin these **exactly** (no `^`, no `latest`, no `beta` tag in the manifest).
Beta tags float; an exact pin is the only thing that makes a beta safe. Re-pin
all three together or not at all — a version skew between them is unsupported.
See [`dependency-updates.md`](dependency-updates.md).

**Known peer warning:** `@effect/atom-react@4.0.0-beta.107` peers on
`scheduler >=0.27.0 <0.28.0`, while `react-dom@19.3.0` requires `scheduler ^0.28.0`.
This is inherent to the package (stable `4.0.2` peers `<0.28.0` too), and
`scheduler` is a react-dom internal we never import. Expect one warning on
install. **Do not** "fix" it by downgrading `react-dom` without approval.

## Reference source — override the `effect` skill

The `effect` skill instructs cloning `Effect-TS/effect-smol`. **That repository
is archived and frozen at `4.0.0-beta.98`**; its final commit is an archive
notice. Effect v4 moved to `Effect-TS/effect`.

**Verify every Effect API against the local clone at `.agents/references/effect`
(cloned from `Effect-TS/effect`, currently v4.0.2), never against `effect-smol`
and never from memory.** `.agents/` is git-ignored; if the clone is missing:

```sh
git clone --depth 1 --branch main https://github.com/Effect-TS/effect.git \
  .agents/references/effect
```

The clone (v4.0.2) and the pinned beta (v4.0.0-beta.107) are **API-identical
for everything below** — verified. Two APIs changed *between* the archived repo
and the pinned beta, so do not carry over older knowledge:

| Stale (effect-smol / beta.98) | Correct |
| --- | --- |
| `effect/unstable/reactivity/Atom` | `effect/reactivity/Atom` |
| `Schema.TaggedErrorClass` | `Schema.TaggedError` |

## Import style

Use Effect's subpath modules, never the barrel:

```ts
import * as Effect from "effect/Effect"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Data from "effect/Data"
import * as Atom from "effect/reactivity/Atom"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { useAtomValue, RegistryProvider } from "@effect/atom-react"
```

## Services (dependency injection)

Class-based `Context.Service` is the required form — v4's own convention, and
it gives you the id, the shape, and the layer in one declaration:

```ts
export class UsageReader extends Context.Service<UsageReader, {
  readonly read: (provider: ProviderId) => Effect.Effect<UsageSnapshot, UsageError>
}>()("app/UsageReader") {
  static readonly layer = Layer.effect(
    UsageReader,
    Effect.gen(function* () {
      const read = Effect.fnUntraced(function* (provider: ProviderId) {
        // provider call goes here; errors are typed
      })
      return UsageReader.of({ read })
    })
  )
}
```

- A service key **is** an Effect: `yield* UsageReader` is the access. Prefer
  `yield*` over `Service.use(...)` — `use` hides the requirement in `R`.
- Layer composition, and the distinction that matters:
  - `Layer.provide(dep)` — dependency stays **private**; output is only `self`'s
    services. Use this by default.
  - `Layer.provideMerge(dep)` — dependency stays **visible** in the output
    `R`. Use only when something downstream genuinely needs `dep`'s services.
- v4 layers already receive their own `Scope`, so `Effect.acquireRelease` inside
  a `Layer.effect` body is closed when the layer tears down. `Layer.scoped` and
  `Layer.effectTag` no longer exist.
- Build the app's services once at the composition root (`lib/runtime.ts`) with
  `ManagedRuntime.make(layer)`. `ManagedRuntime.runPromise` is how a React
  event handler or a non-Effect callback enters the Effect world;
  `runPromise` requires `R = never`, so unsatisfied services are a type error,
  not a runtime surprise.
- **v4 gotcha:** the `MemoMap` is shared across `Effect.provide` calls by
  default. That is what you want here (one shared layer memo map per app). Opt
  out per call with `Effect.provide(layer, { local: true })` or `Layer.fresh`
  only when a test needs isolation.

## Errors

- Typed errors only. Use `Data.TaggedError` for a plain tagged error, or
  `Schema.TaggedError` when the fields should be schema-validated:

```ts
export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String,
  provider: Schema.String
}) {}
```

  It yields like an error: `yield* new UsageError({ ... })`.
- Recover with `Effect.catchTags` (keys are `_tag` values, type-checked),
  `Effect.match` / `Effect.matchEffect` (pure vs effectful), or `Effect.catch`
  (v4's name — `Effect.catchAll` is gone).
- Model domain state as data, not exceptions. There is no `try`/`catch` and no
  `async`/`await` inside Effect code — defects are the runtime's business.
- Never stringify an error to recover from it. Narrow on the tag.

## Schema at the boundary

The IPC payload from Rust is untrusted. Decode it, do not cast it:

```ts
export const decodeUsageSnapshot = Schema.decodeUnknownEffect(UsageSnapshot)
```

- Reuse the decoder at the edge; do not rebuild it per call.
- `SchemaError` is a tagged error with a readable `.message`; narrow with
  `Schema.isSchemaError`. A decode failure becomes an `unavailable` state, never
  a rendered number.

## Config

`Config` **is** an Effect — `yield* Config.string("NAME")` resolves from the
current `ConfigProvider`. `Config.withDescription` no longer exists. Use
`Config.option` / `Config.withDefault` for optional values. For non-secret
values, prefer passing configuration into the layer that needs it rather than
reading globals.

## Atoms (state)

Client state is atoms, not `useState` mirrors.

```ts
export const usageAtom = Atom.make(Effect.gen(function* () {
  const reader = yield* UsageReader
  return yield* reader.read("codex")
}))                                  // Atom<AsyncResult<UsageSnapshot, UsageError>>

export const usageByProvider = Atom.family((provider: ProviderId) =>
  Atom.make(Effect.gen(function* () {
    const reader = yield* UsageReader
    return yield* reader.read(provider)
  })))
```

- `Atom.make` overloads: a plain value → writable state atom; a function of
  `get` → computed atom; an `Effect`/`Stream` → `AsyncResult` atom.
- `Atom.make(effect)` may require only `Scope | AtomRegistry` — both injected.
  To reach app services, build the atom from a runtime:
  `const runtime = Atom.runtime(AppLayer)` then `runtime.atom((get) => …)`.
  The layer is built once, in the registry's scope.
- `Atom.keepAlive(atom)` for anything that must survive having no subscribers
  (selected provider, cached window geometry). Atoms are lazy and disposed when
  unused, so the default loses state.
- Never put a secret, token, or raw credential in an atom — atoms are read by
  components and are trivially inspectable. See [`security.md`](security.md).

### AsyncResult is the state model

An effectful atom's value is `Initial | Success | Failure`, each carrying
`waiting`. Match on it; never read `.value` blindly:

```ts
const result = useAtomValue(usageAtom)
AsyncResult.match(result, {
  onInitial: () => <Loading />,
  onSuccess: (s) => <UsageCard snapshot={s.value} waiting={s.waiting} />,
  onFailure: (f) => <Unavailable cause={f.cause} />
})
```

This maps onto the app's four required states: `Initial`→no data yet,
`Success`+`waiting`→stale-while-revalidate, `Failure`→unavailable.
`waiting` on a `Success` means a refresh is in flight — never render that as a
fresh reading. See [`ui.md`](ui.md).

## React wiring

- Mount `<RegistryProvider>` **once, at the app root**, so the app gets an
  isolated registry and can seed initial values. Without it the hooks fall back
  to a module-level shared registry.
- Hooks: `useAtomValue` (read, optional selector), `useAtomSet` (write),
  `useAtomRefresh` (returns a refresh fn), `useAtom` (both, as a tuple),
  `useAtomMount` (subscribe for side effects only), `useAtomSubscribe`,
  `useAtomSuspense` (throws on `Initial`, and on `Failure` unless
  `includeFailure` — pair with an error boundary).
- `browser.mock` note for e2e: mocking a Tauri command patches `invoke` in the
  renderer, which is exactly the seam `Effect.tryPromise` wraps — so command
  mocks still work under atoms.
- A component that reads an atom must not also hold the same value in
  `useState`. If a component needs local UI state (an open/closed flag), that is
  fine; if it mirrors fetched data, it is a bug.

## The IPC boundary

`invoke` is a promise-returning foreign function, so it becomes an Effect at
exactly one place per command:

```ts
export const getUsage = (provider: ProviderId) =>
  Effect.tryPromise({
    try: (signal) => invoke<unknown>("get_usage", { provider, signal }),
    catch: (cause) => new IpcError({ cause })
  })
```

- `Effect.tryPromise` hands you an `AbortSignal` — thread it into the request so
  unmount and refresh actually cancel work.
- Decode the resolved `unknown` with `Schema` before it reaches a component.
- Network-level failure (`IpcError`) and API-status failure (`UsageError`) are
  **different types**; never collapse them into one.
- No `invoke` in a component, ever. No `fetch` in the renderer at all — network
  access belongs to Rust. See [`tauri.md`](tauri.md).

## Runtime lifetime in a Tauri webview

- There is **no `process`** in the renderer, so the usual
  `process.once("SIGINT", …)` / `ManagedRuntime.dispose()` shutdown pattern from
  Effect's server docs does not apply. Do not import it.
- Atom-backed resources are released by the registry when unmounted, and the
  registry is released on window teardown. For app-lifetime resources, keep them
  in the root layer and let the provider own their scope.
- Effects that need to outlive a component must be deliberately kept alive
  (`Atom.keepAlive`) — do not leak intervals or listeners.

## Testing

- `it.effect` (virtual `TestClock` + ambient `Scope`) for anything with time or
  resources; `it.live` only when you genuinely need real time.
- Use **`assert` from `@effect/vitest`**, not `expect` — Effect's own house rule.
- **Never `Effect.runSync` in tests.** Assert failures as data:
  `Effect.runPromise(program.pipe(Effect.result))` compared against
  `Result.succeed` / `Result.fail`.
- Time is injected — use `Clock` / `TestClock`, never `Date.now()`. Relative
  timestamps must be deterministic.
- Provide stub layers with `it.layer(...)` or `Effect.provide(…, Layer.succeed(Svc, …))`,
  and `Layer.mock(Svc, partial)` for partial fakes.
- Atom + React tests: render inside `RegistryProvider` and seed the runtime layer
  with `Atom.initialValue(runtime.layer, TestLayer)` to swap implementations —
  that is the supported way to test the renderer without Rust.
- jsdom + `@testing-library/react` for component tests; the wdio e2e suite
  remains the gate for real native behaviour. See [`testing.md`](testing.md).

## Anti-patterns

| Never | Instead |
| --- | --- |
| `async`/`await` inside an Effect-returning function | return the `Effect` |
| `try`/`catch` to handle a failure | typed error + `catchTags` / `match` |
| `Promise` stored in `useState` | an atom |
| `Effect.runSync` (esp. in tests) | `runPromise`, or `it.effect` |
| `Date.now()` / `new Date()` for logic | `Clock` / `Effect` time services |
| a `.then()` chain | `Effect.gen` |
| importing from `"effect"` barrel | subpath imports |
| secrets in atoms or component state | OS keychain, reached from Rust |
| `any` to silence an Effect type error | fix the `R`/`E` channel |