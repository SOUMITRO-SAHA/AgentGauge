# Testing & Validation Rules

There is no CI in this repo — the commands below, run locally before you finish, are the gate. The Husky pre-commit hook only formats the Flutter app (`cd apps/libryva && make format`); it does not validate correctness.

## Definition of done (every change)

Run the checks for **every app you touched**:

| App                          | Commands (run inside the app dir)                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server` (Rust)         | `cargo fmt --all --check` · `cargo clippy --workspace --all-targets --all-features -- -D warnings` · `cargo test --workspace` (unit suite; the ignored `mfa_flow` e2e runs explicitly with `make test-e2e`) · **Postman: run the `server` collection (root `postman/`) when HTTP routes change — see "API test automation" in the root `AGENTS.md`** |
| `apps/mcp_server` (Hono/Bun) | `bun test src` · `bun run check-types` · `bun build src/index.ts --target=bun --outfile /dev/null` · **Postman: run the `mcp_server` collection (root `postman/`) when routes change — see "API test automation" in the root `AGENTS.md`**                                                                                                           |
| `apps/libryva` (Flutter)     | `make analyze && make test` · `make format-check` (strict mode: `make lint`) · **UI changes: `make test-ui`** (Patrol smoke, see below)                                                                                                                                                                                                              |
| `apps/website` (Astro)       | `bun run build` (no warnings) · `bunx astro check` (0 errors, 0 warnings)                                                                                                                                                                                                                                                                            |
| `apps/web-extension`         | `bun test src` · `bun run check-types` · `bun run build` (+ `bun run build:firefox`) · **`bun run test:e2e`** (deterministic Puppeteer harness, see below) · visual smoke test via Puppeteer MCP for interactive/visual review (see the `puppeteer-ui-testing` skill — extension suite)                                                              |

All applicable commands must pass before work is considered complete. Never finish with analyzer warnings or errors.

## Test-first development (binding)

- Start every behavior change and bug fix with the smallest focused test that
  demonstrates the desired contract or regression. Confirm it fails for the
  intended reason before implementation, then make it pass with the smallest
  production change and refactor only while the suite stays green.
- Test observable behavior and public contracts, not private implementation
  details. Unit-test pure transformations and error branches directly; use
  integration tests at framework, transport, persistence, or browser
  boundaries.
- Refactors preserve or improve coverage. When extracting a module, move its
  existing tests and add direct tests for newly public pure helpers and every
  meaningful success, validation, and error branch.
- No feature, defect fix, or security fix is complete without automated
  coverage. If automation is genuinely impossible, document the precise
  manual verification and why in the task record.

## Test expectations

- New behaviour ships with tests. Bug fixes ship with a regression test that fails without the fix.
- **Rust** (`apps/server`): unit tests inline (`#[cfg(test)]`); integration tests in `tests/`.
- **MCP hub** (`apps/mcp_server`): all tests live in `src/__tests__/`.
  `<subject>.test.ts` unit-tests pure constants, schemas, renderers, and
  utilities directly; `mcp-http.test.ts` drives the real Hono + MCP transport
  over loopback HTTP with stubbed Effect layers. Never use MCP SDK
  `InMemoryTransport` under Bun.
- **Flutter** (`apps/libryva`): tests live in `test/` mirroring the `lib/` structure, using `flutter_test` (+ `mocktail` for fakes). New features require tests for business logic; non-trivial UI gets widget tests.
- **Flutter UI smoke** (`apps/libryva`): navigation/visual flows are validated on the Android emulator with **Patrol** — suites in `patrol_test/`, run via `make test-ui`, screenshots pulled to `build/patrol-screenshots/`. Run it for UI/navigation changes; see the `patrol-ui-testing` skill for the procedure, pass criteria, and agent workflow.
- **Website** (`apps/website`): no runtime test suite — validation is the build + `astro check`; content changes must satisfy the `content.config.ts` zod schemas and the SEO checklist (§52 of `.agents/rules/seo-optimisation.rules.md`).
- **Web extension** (`apps/web-extension`): deterministic Puppeteer e2e is the automation gate — see the dedicated section below.
- **Postman API tests (both HTTP backends):** `apps/server` and `apps/mcp_server`
  endpoints are mirrored 1:1 in the repo-root `postman/` workspace under
  `collections/<app>/{local,production}/`. The `production/` folders run via
  the `postman` cloud MCP against the deployed URLs (`api.libryva.com`,
  `mcp.libryva.com`) — read-only and negative-path requests only, never
  writes against production. The `local/` folders run in the Postman desktop
  app against the dev stack (server `make dev` :8000, mcp hub
  `bun run src/index.ts` :8080). All Postman queries, authoring, and runs go
  through the `postman` cloud MCP — never the Postman CLI, `newman`, or raw
  Postman API calls — and any collection create/replace via the MCP uses
  Collection Format v3 (`3.0`). Procedure, contracts, and safety rules:
  "API test automation" in the root `AGENTS.md` and `postman/README.md`.

## Web extension — deterministic e2e + MCP exploratory testing

`apps/web-extension` ships unit tests for its pure utils (`bun test src`) and a
deterministic Puppeteer e2e harness that drives the **built** extension
(`.output/chrome-mv3`) in headless Chrome via `--load-extension`. The harness
is the regression gate; the Puppeteer MCP browser remains the tool for
interactive/visual debugging and exploratory review of UI changes.

Run it with:

```sh
cd apps/web-extension && bun run test:e2e
```

(the script builds first — never test stale output — then runs `bun test e2e`).

How it works: the harness in `apps/web-extension/e2e/` computes the unpacked
extension id from the output path, opens `popup.html` and
`app.html` as tabs, seeds/clears `chrome.storage.local`
(`savedArticles`, `outbox` keys — which also proves the storage-watch
reactivity), and asserts rendered output with one structured evaluate per
state. The popup save flow is covered by stubbing `chrome.tabs.query` +
`chrome.scripting.executeScript` before page scripts run, then asserting the
full local-first pipeline: storage row (metadata-only) + outbox capture +
button state. Screenshots of every major state land in
`.temp/screenshorts/extension-e2e-*.png` (repo root, git-ignored).

Minimum e2e coverage (a run is complete only when all are asserted):

1. Dashboard (`app.html`) renders seeded article cards (thumb or
   fallback tile, title link, source, read time, bookmark) newest-first.
2. Filter chips filter the list; active chip styling applies; All restores.
3. Bookmark toggle removes an article from the list **and** from storage.
4. Search opens focused (pill, or ⌘K / Ctrl+K), filters by title/source, and resets on close.
5. Empty states render (no articles / empty filter / empty search).
6. Bottom nav switches to placeholder views (Home/Library/Profile) and back.
7. Popup renders: brand header, expand button, chips, saved list
   newest-first; save-row hint on non-savable pages.
8. Popup save flow: Save persists the article and queues the outbox capture;
   an already-saved page toggles off and drops the queued capture; expand
   opens the library in a new tab.

Manual-only (cannot be automated by either harness): the context-menu "Save
article to Libryva" flow and the toolbar badge — context menus cannot be
clicked programmatically. The REAL on-page injection
(`scripting.executeScript` behind `activeTab` against a live page) is also
verified manually when touched; the e2e covers everything around it with a
stubbed extraction. Unit tests + typecheck + builds remain mandatory
alongside the e2e run (DoD table above).

Environment note: if `PUPPETEER_EXECUTABLE_PATH` is set on the machine but
points at a missing binary, the harness falls back to puppeteer's own
downloaded Chrome for Testing (`~/.cache/puppeteer`). Set `E2E_CHROME` to
point at a specific Chrome binary.

## Test environment

- Tests never depend on network access, real API keys, or external services.
- Local authenticated API/client testing may use the shared dev-login identity
  held in `apps/server/.env.local`. Load it into the local test process without
  displaying values (for example, from `apps/server`, run
  `set -a; source .env.local; set +a; ./auto_testing/run.sh`); the runner
  reads `DEV_LOGIN_EMAIL` / `DEV_LOGIN_PASSWORD` and the server continues to
  use its existing `DEV_LOGIN_EMAILS` / `DEV_LOGIN_SALT` settings. Never copy
  the password into commands, logs, fixtures, docs, reports, or agent output.
  This identity is local-only and must never be used against production
  services or databases.
- **Never run tests or one-off queries against the production Neon database.** Neon is production only, and its URL lives solely in `apps/server/.env.prod`, which local server processes never load; `shared/config.rs` reads `.env.local`/`.env` only. ECS receives runtime secret values from Secrets Manager. Local runs use `.env.local`, which points at the dev DB through `dev-db.sh`, so a plain `cargo run` cannot reach production. Still never boot a test server with an explicit production `DATABASE_URL`.
- **The dev/test database is the local docker-compose stack in `apps/server`** (`libryva-dev-postgres` + redis + pgAdmin, loopback-only) — managed via `apps/server/scripts/dev-db.sh` (`up`, `url`, `env`; `.env.local` carries the dev DB URL, and `eval "$(./scripts/dev-db.sh env)"` re-exports it or selects another database such as `libryva_e2e`). Do not install, run, or spin up PostgreSQL anywhere on a dev machine (brew, docker, or otherwise) — the dev compose stack replaces all of that. Production Neon is never touched by tests or local runs. **MCP-hub tooling never needs the DB at all**: dev sessions are minted over HTTP via the server's `POST /auth/dev-login` (plain curl with a `DEV_LOGIN_EMAILS`-allowlisted email + the `DEV_LOGIN_SALT` password; machine IP must be in the server's `ip_allowlist` table, scope `dev_login`, and the mailbox must hold the `dev` role) — DB access from the hub is strictly prohibited.
- Filesystem behaviour (Flutter import/file-manager flows, server migration SQL) is tested against temporary fixtures — never the developer's real data or repo state.
- Time-dependent logic must be injectable/deterministic in tests: route `Utc::now()` / `DateTime.now()` behind an injectable clock wherever logic depends on it.
