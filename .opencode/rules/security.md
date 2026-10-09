# Security Rules

Applies to every app in the monorepo: `apps/server` (Rust HTTP API + Neon PostgreSQL), `apps/libryva` (Flutter), `apps/website` (static Astro).

## Secrets

- `.env` files are credentials — never commit them. Only `.env.example` (shape, no real values) belongs in the repo.
- Never log or persist secrets — `DATABASE_URL`, API keys, tokens — not in server logs, error messages, checkpoints, debug output, or conversation/tool results.
- Prefer OS-level credential storage over app-local storage for sensitive credentials. Never store secrets in the local SQLite database or anywhere in the website bundle.

## Server (`apps/server`)

- Every request is untrusted input: bodies, query strings, headers, and path segments. Validate and coerce at the boundary with strict serde DTOs; never trust values downstream.
- Use the diesel DSL / bound parameters for all queries. Never interpolate user input into SQL — including `sql_query` calls; if raw SQL is unavoidable, use `.bind::<Type, _>(...)`.
- Keep TLS as shipped: Neon requires `sslmode=require` via `rustls` + `rustls-platform-verifier`. Never downgrade certificate verification or add bypass flags to make a connection work.
- Client-facing error bodies must not leak SQL, connection strings, pool internals, or stack traces; detailed diagnostics belong in server-side logs only.
- Migrations run embedded at startup — never modify an already-applied migration; schema history is security-relevant state.

## Flutter (`apps/libryva`)

- Imported audio files are untrusted input: metadata parsing (tags, cover art, embedded paths) must be resilient to malformed files and never execute or trust embedded locations.
- The local drift/SQLite database is not encrypted — no secrets in it, ever.
- Do not add network access to features that don't require it; server communication goes through the shared API layer only.

## Website (`apps/website`)

- Static-only means no secrets client-side: never embed keys, tokens, or private URLs in `site.ts`, components, or content.
- Never bypass Astro's escaping with `set:html` on dynamic or untrusted content (content collections, URL-derived values).
- The zero-client-JS principle is also a security posture: no third-party scripts without explicit justification.

## Supply chain

- No new dependencies — crates, pub packages, npm packages, or `cargo install` CLIs — without explicit approval; list name, version, and justification first.
- Do not add network access to any component that does not explicitly require it. Today the networked surfaces are only `apps/server` and the Flutter app's sync/download features.
