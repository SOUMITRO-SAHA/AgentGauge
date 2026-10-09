# TypeScript Rules (backend)

These rules apply to all **backend/server TypeScript** in this repo — today that is `apps/mcp_server` (the central MCP hub serving every ChatGPT plugin) and any future TS services, workers, or scripts. They do **not** apply to `apps/web-extension` (WXT/React frontend) or `apps/website` (Astro site config) — those keep their own conventions. Plugin bundles under `apps/plugins/*` are distribution-only artifacts (manifest + skills) with no code.

**The stack is fixed: Effect v4 (beta) for all backend logic, Hono on Bun for every server.** A TS server that is not Hono-on-Bun, or backend TS that bypasses Effect, needs explicit user approval before it is written.

## Toolchain

- Runtime is **Bun** (`bun run`, `bun test`, `bun install`). No Node-only APIs without a Bun fallback check.
- **Shared compiler options — `@libryva/tsconfig`** (`packages/tsconfig`). Every hand-rolled tsconfig in `apps/*` / `packages/*` extends a variant (`base`, `ts-library`, `bun-service`, `react-library`, `vite-react`, `vite-node`) and keeps only local `include`, `compilerOptions.paths`, and `tsBuildInfoFile`. Never re-declare an option a variant sets — change the variant. `apps/web-extension` (WXT) and `apps/website` (Astro) stay on their framework-shipped bases by design. See `packages/tsconfig/README.md`.
- **Effect v4 beta** — the `effect` npm package's `beta` dist-tag (e.g. `4.0.0-beta.107`), pinned **exact once in the root `workspaces.catalog`** and referenced as `"effect": "catalog:"` by every consumer. Do not "upgrade" to `latest` (that is v3) or `rc` unless the user says so.
- **Hono** for every HTTP server (`^4.x`), served with `Bun.serve({ port, fetch: app.fetch })`.
- The source of truth for Effect APIs is the cloned reference `.agents/references/effect-smol` (see the `effect` skill) — **never answer Effect questions from v3 memory**; v4 renamed or removed major APIs. Verified cheat sheet below.

## Effect v4 cheat sheet (verified against effect-smol)

| v3 habit                                                | v4 reality                                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `Context.Tag` / `Context.GenericTag` / `Effect.Service` | gone — use `class Foo extends Context.Service<Foo, Shape>()("app/Foo")`           |
| `Layer.scoped(...)`                                     | gone — `Layer.effect` absorbs `Scope` automatically                               |
| `Effect.config(cfg)`                                    | gone — a `Config` **is an Effect**: `yield* Config.string("NAME")`                |
| `Config.withDescription`                                | gone                                                                              |
| `Logger.logfmt`                                         | `Logger.formatLogFmt` / `Logger.consoleLogFmt` (default logger is on, zero setup) |
| `HttpClientRequest.bearerAuth`                          | `HttpClientRequest.bearerToken` (HTTP client now lives at `effect/unstable/http`) |
| running from callbacks                                  | `Effect.runPromise` / `ManagedRuntime.make(layer)` + `runtime.runPromise`         |

Canonical service shape:

```ts
export class LibryvaClient extends Context.Service<LibryvaClient, {
  getThing(token: string): Effect.Effect<IThing, TClientError>
}>()("app/LibryvaClient") {
  static readonly layer = Layer.effect(LibryvaClient, Effect.gen(function* () {
    // dependencies are yielded, not provided here — compose at the app root
    return LibryvaClient.of({ getThing: (token) => ... })
  }))
}
```

- Access a service with `yield* Foo` inside `Effect.gen`, or `Foo.use((foo) => program)` at a callback boundary.
- Typed errors only: `class BarError extends Data.TaggedError("BarError")<{ ... }>() {}`; recover with `Effect.catchTags({ BarError: (e) => ... })` (accepts a tag or tag array). Never `try/catch` inside Effect code — defects are the runtime's business.
- Wrap promises with `Effect.tryPromise({ try, catch })` — the `catch` maps to a typed error; network-level failures get their own error type distinct from API-status errors.
- Bracket SDK resources with `Effect.acquireUseRelease(acquire, use, release)`.
  The release must await async SDK cleanup even on typed failure. Build one
  `ManagedRuntime` at boot and await `runtime.dispose()` during idempotent
  `SIGINT`/`SIGTERM` shutdown.
- Config: read env through `Config.string(...)`/`Config.int(...)` with `Config.option`/`Config.withDefault`; normalization that must stay lenient (invalid values falling back to defaults) belongs in a pure exported function the layer calls and the tests cover directly.

## App shape (the reference implementation is `apps/mcp_server`)

```
src/
  index.ts                        # boot: layers -> ManagedRuntime -> Bun.serve(app.fetch)
  app.ts                          # Hono routes — thin adapters ONLY
  integration-registry.const.ts   # fixed integration registry
  constants/                      # cross-cutting immutable runtime values
  types/                          # shared interfaces and type aliases only
  libs/
    services/                     # Effect Context.Service definitions, layers, transport factories
    utils/                        # pure helpers with no framework lifecycle or environment access
  <feature>/
    <feature>.integration.ts      # one platform/flow registration
    <feature>.schemas.ts          # Zod boundary schemas
    <feature>.types.ts            # feature-local contracts
    <feature>*.utils.ts           # focused renderers, mappers, or error translation
  __tests__/                      # `<subject>.test.ts`, including loopback HTTP integration tests
```

- Keep only the process boot, Hono edge, and immutable registry at `src/`
  root. Place reusable code by role under `constants/`, `types/`, or `libs/`;
  place domain-specific code vertically under its feature directory.
- Constants contain immutable shared values only; types contain no runtime
  values. `libs/services/` owns Effect layers and framework-facing lifecycle
  work. `libs/utils/` stays deterministic and framework-agnostic, making its
  behavior directly unit-testable.
- Feature integrations compose schemas, renderers, and services. They do not
  duplicate transport, authentication, configuration, or generic error-handling
  logic. Imports flow from feature code toward shared code, never the reverse.
- Tests use the central `src/__tests__/` directory. Name every test after the
  contract it covers; unit-test extracted helpers directly and retain
  loopback-HTTP tests for the full Hono/MCP boundary.

- **Boundary discipline:** Hono handlers (and SDK callbacks — e.g. MCP tool registrations) contain **no business logic**. They call `runtime.runPromise(program)` where the program is an `Effect` built from services. Typed errors are converted to output _inside_ the Effect (`catchTags`) so the boundary awaits an infallible result; a final `try/catch` at the boundary only guards defects.
- One `ManagedRuntime` per process, built once at boot (`Layer.provideMerge` keeps shared deps like config visible). For per-request frameworks (MCP transport), build the inner server per request but reuse the runtime.
- Treat third-party SDK setup, I/O, and cleanup as effectful boundaries:
  capture rejected promises as tagged errors with `tryPromise`, map expected
  failures with `catchTags`, and bracket request-scoped resources with
  `acquireUseRelease`.
- A framework that hands you a raw `Request` (MCP transports) is mounted via passthrough: `app.all("/mcp", (c) => handle(c.req.raw))` — the adapter returns the framework's `Response` directly.

## Testing

- `bun test src` (`src/__tests__/*.test.ts`); typecheck with `tsc --noEmit` (`check-types` script).
- Follow the binding test-first workflow in `.agents/rules/testing.md`: write
  the focused failing test, make it pass with the smallest change, then
  refactor under the green suite.
- Test Effect services by providing stub layers: `Layer.succeed(Foo, Foo.of(stubShape))`, then `Effect.runPromise(program.pipe(Effect.provide(stubLayer)))`; assert failures with `Effect.flip`.
- **Do not use the MCP SDK's `InMemoryTransport` under Bun** — its connect handshake hangs (verified Bun 1.4.2, SDK alone, no Effect involved). Drive MCP servers over real loopback HTTP instead: boot the Hono app on port 0 in the test and POST JSON-RPC with `fetch` (see `src/create-server.test.ts`).

## Dependencies

- Never add or upgrade a dependency without explicit user approval — name, version, and why (same policy as Rust).
- `effect` stays pinned to the beta line and moves only on instruction.

## Style

- Names follow [naming-convention.md](naming-convention.md): kebab-case files, `PascalCase` service classes, `I`-prefixed interfaces, `T`-prefixed type aliases, `SCREAMING_SNAKE_CASE` compile-time constants only.
- Comments follow the canonical rule [documentation.rules.md](documentation.rules.md): JSDoc on exported symbols with real contracts, no narration of _what_.
- Zero `tsc --noEmit` errors; zero warnings from `bun run check-types`.
