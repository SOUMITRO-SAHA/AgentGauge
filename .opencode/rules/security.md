# Security Rules

Applies to the whole repo: the Tauri shell (`app/src-tauri/**`), the renderer
(`app/src/**`), and — once it exists — `website/`. This is a **local desktop
app that talks to third-party providers with the user's own credentials**, so
the trust boundaries are the IPC bridge, the webview, and the provider APIs.

## Trust model

| Boundary                 | Trust                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `#[tauri::command]` args | **Untrusted.** The renderer is a webview; treat every argument as attacker-controllable.         |
| Provider HTTP responses  | **Untrusted.** Third-party JSON — validate before parsing into domain types; never trust shape or size. |
| Provider credentials     | **Secret.** Belong in the OS keychain, never in the renderer, config, or repo.                    |
| Capability permissions   | The **entire** frontend privilege boundary — every added permission widens it.                   |
| The local filesystem     | Local and user-owned, but provider data written there may still contain sensitive account info.  |

Anything crossing the IPC boundary is untrusted input, exactly like an HTTP
request body. Validate and coerce with serde at the boundary; never trust a
value downstream.

## Capabilities & the webview (Tauri-specific)

- `app/src-tauri/capabilities/default.json` is the security perimeter. Grant
  only the specific commands a feature needs; **never a wildcard or a whole
  permission set "to make it work"**. Every new permission is approval-gated.
- New features get a new capability file with a clear `description`; do not grow
  the default capability into a dumping ground.
- `wdio:default` / `wdio-webdriver:default` are **test-only**. Keep them behind
  `#[cfg(debug_assertions)]` registration in `lib.rs` (they are). Never expose
  the embedded WebDriver in a release build — it is remote code execution.
- `app.security.csp` is currently `null`. That is acceptable for the throwaway
  starter app but is **not shippable**: set a real CSP (`default-src 'self'`,
  no `unsafe-eval`) before any build that reaches users. Never disable
  `withGlobalTauri` casually — it is required by the e2e harness.
- Never add a remote origin to `devUrl`, `frontendDist`, or a capability to work
  around a problem.
- `app/src/main.tsx` imports `@wdio/tauri-plugin`; do not remove it or the
  suite breaks.

## Secrets & credentials

- `.env` files are credentials — never commit them. Only `.env.example` (shape,
  no real values) belongs in the repo. The root `.gitignore` already ignores
  `.env`/`.env.*`.
- Never log, print, or echo secrets, API keys, tokens, session cookies, or full
  provider responses — not in Rust logs, not in e2e `console.log`, not in
  errors surfaced to the UI, not in agent output or task notes.
- Store credentials in the **OS credential store** (macOS Keychain, Windows
  Credential Manager, Secret Service on Linux) accessed from Rust. Never in
  frontend source, a plain-text config file, `tauri.conf.json`, or the repo.
- Do not put tokens in the URL, query string, or command name — only in
  headers or bodies, over HTTPS.
- If a secret is ever committed or logged in error, treat it as compromised:
  rotate it and remove it from history. Do not just delete the file.

## Renderer & IPC hygiene

- The renderer makes **no direct network calls**; provider data comes through
  Rust. This keeps tokens out of the webview. Do not add `fetch` to the client
  for provider data.
- **Effect does not change the trust model.** Typed errors, Schema decoding, and
  `Context.Service` give structure, not safety: a value that reaches a component
  is still untrusted, and an atom is still readable by any component.
- Never put a secret, token, or raw credential in an **atom**, a service shape
  exposed to the renderer, or a `Config` value read in the webview. Atoms are
  trivially inspectable from devtools and are serialised into the renderer.
  Credentials belong in Rust and the OS keychain; see
  [`effect.md`](effect.md).
- Never pass secrets or raw credentials across IPC into renderer state.
- Never use `dangerouslySetInnerHTML` / `set:html` with provider or user data.
  If text must be shown, render it as text.
- Validate and clamp everything a command receives: string lengths, enum
  discriminants, numeric ranges, array sizes, and timeouts. Reject rather than
  silently truncate where a wrong value would be a security or correctness bug.
  On the client, decode `invoke`'s `unknown` result with a `Schema` — never
  cast it.
- IPC errors surfaced to the UI must not leak tokens, file paths outside the
  app, or raw provider response bodies. Render a `Cause` with `Cause.pretty` /
  `Cause.squash`, never by string-interpolating the raw cause. Log detail on
  the Rust side only.

## Provider integrations

- Use **documented, authorized provider APIs**; respect provider terms and
  rate limits. Back off on 429s; do not hammer or evade provider limits.
- Read-only by default. Any action that mutates an account, spends quota, or
  sends a request **on the user's behalf** must be explicit, understandable,
  and under the user's control — confirm before enabling it, and never perform
  destructive account actions unattended. See `AGENTS.md`.
- Send credentials only to the provider's real origin over HTTPS. Never to a
  user-configurable or URL-derived host.
- Do not exfiltrate telemetry anywhere. There is no analytics, crash reporter,
  or update-check server — adding one is a product decision requiring explicit
  approval, and it must be disclosed.

## Data honesty

- Handle provider failure, missing permissions, and auth expiry without
  presenting fabricated values as real usage or status (see `AGENTS.md`,
  [`ui.md`](ui.md), [`typescript.md`](typescript.md)).
- A cached or stale value is not a live value. Label it as such; never render a
  placeholder, `0`, or `-` that reads like a real measurement.

## Supply chain & the website

- **No new dependencies** — npm/Bun packages, Cargo crates, or CLI installs —
  without explicit approval; list name, version, and why first. Fresh releases
  are additionally blocked for 15 days by `app/bunfig.toml` (see
  [`dependency-updates.md`](dependency-updates.md)).
- Keep lockfiles (`app/bun.lock`, `app/src-tauri/Cargo.lock`) in sync and never
  hand-edit them.
- The release profile (`lto`, `strip`, `panic = "abort"`) ships smaller binaries;
  do not weaken it. Do not ship debug assertions.
- `website/` (future): static-only means no secrets client-side. Never embed
  keys or private URLs, and never add third-party scripts without justification.