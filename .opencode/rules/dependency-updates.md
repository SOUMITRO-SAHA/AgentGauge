# Dependency Updates

Applies to every dependency in the repo: the Bun packages in `app/package.json`
and the Cargo crates in `app/src-tauri/Cargo.toml`.

## The approval gate (binding)

**Never add, remove, or upgrade a dependency without explicit user
approval.** Before asking, produce:

1. **Name and exact version** to install.
2. **Why** it is needed and what problem it solves.
3. **What it costs** — transitive dependency count, bundle size (npm) or
   compile time and binary size (crate).
4. **Alternatives considered**, including "do it by hand".

Then stop and wait for a decision. This applies to `dependencies`,
`devDependencies`, Cargo crates, and installed CLIs alike. Removing a
dependency needs approval too — something else may still be importing it.

The client has no unit-test runner, no linter, and no state library today.
Reaching for one is exactly the kind of change this gate exists to catch.

## The release-age gate (15 days)

**Never adopt a package or crate version published less than 15 days ago** —
direct dependency, catalog entry, or transitive resolution. Fresh releases carry
unresolved risk: supply-chain compromises are usually caught within days of
publication, and brand-new releases ship unexercised regressions.

This is enforced natively by Bun, not by a script:

```toml
# app/bunfig.toml
[install]
minimumReleaseAge = 1296000 # 15 days, in seconds
```

`bun install` / `bun add` / `bun update` filter out anything newer than the
threshold and resolve to the oldest-enough newest version. Range syntax in the
manifest stays normal; no manual pinning is needed. During the gate's warm-up
this is why `expect-webdriverio` is pinned to `6.1.0` — newer versions existed
but were not yet installable. That is the rule working, not a bug.

Useful knobs:

- `bun add <pkg> --minimum-release-age <seconds>` — per-invocation override.
- `install.minimumReleaseAgeExcludes = ["pkg"]` in `bunfig.toml` — per-package
  exemption. Keep the list empty by default; add an entry only with a recorded
  reason, and remove it once no longer needed.

Cargo has no equivalent native gate — apply the 15-day rule to crate versions
by checking the release date before approving the bump.

## Sole exception

**Security fixes.** A release patching a CVE actively exploited against a
version we ship may be adopted immediately, before the 15 days are up: pass
`--minimum-release-age 0` for that one install, or add a temporary
`minimumReleaseAgeExcludes` entry. Note the CVE and the exemption in your
summary, then remove the exemption once it is no longer needed.

## Updating procedure

1. Propose the bump (approval gate above) and get a yes.
2. Bump the version in the manifest. Shared JS versions live only in
   `app/package.json` — there is no workspace root and no catalog block.
3. Run `bun install` (or `cargo update`). If the gate held a version back,
   note it so it can be picked up once it has aged.
4. Commit the manifest **and** its lockfile together: `app/bun.lock` or
   `app/src-tauri/Cargo.lock`. Never hand-edit a lockfile; never commit a
   manifest change without the matching lockfile.
5. Re-run the gates in [`testing.md`](testing.md). A major bump that changes
   types or Tauri API surface needs the e2e run, not just a build.
6. If the gate blocked a version, record it so a follow-up can retry.

## Lockfiles

- `app/bun.lock` and `app/src-tauri/Cargo.lock` are committed and must stay in
  sync with the manifests.
- Never regenerate a lockfile wholesale to "fix" a problem — it hides drift and
  pulls in unrelated upgrades.
- A `bun install` that rewrites unrelated versions is a red flag: check
  `git diff` on the lockfile and revert anything not part of the approved bump.

## Automated updates

There is **no Dependabot, Renovate, or CI workflow** configured in this repo
yet. If one is added, its PRs are not subject to the 15-day gate (it brings its
own lockfile updates) — review them like any other change and merge through the
normal gates. The 15-day rule still governs every manual or agent-driven
`bun add` / `cargo update`.