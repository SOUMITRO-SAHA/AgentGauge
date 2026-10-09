# Dependency updates — 7-day minimum release age

Guidance for AI coding agents and humans updating npm dependencies anywhere
in the monorepo (root `package.json` catalog, `apps/*`, `packages/*`).

## The rule (binding)

**Never adopt a package version published less than 7 days ago** — direct
dependency, catalog entry, or transitive resolution alike. Fresh releases
carry unresolved risk: supply-chain compromises are almost always caught
within the first days of publication, and brand-new releases ship
unexercised regressions. Waiting out 7 days is the cheapest defence.

## Enforcement (native, automatic)

Enforced by Bun itself — no script, no CI step:

```toml
# bunfig.toml (repo root)
[install]
minimumReleaseAge = 604800 # 7 days, in seconds
```

During `bun install` / `bun add` / `bun update`, Bun filters out any version
published more recently than the threshold and resolves to the newest
version that is old enough. This covers carets that would otherwise float
onto a too-fresh release, and every transitive dependency. Range syntax in
manifests stays normal — no manual exact-pinning needed.

Useful knobs (see the [Bun docs](https://bun.com/docs/pm/cli/install)):

- `bun add <pkg> --minimum-release-age <seconds>` — per-invocation override.
- `install.minimumReleaseAgeExcludes = ["pkg"]` in `bunfig.toml` — per-package
  exemption. Keep this list empty by default; add only with a recorded reason.

## Updating dependencies

1. Bump versions / add packages as usual (shared versions go through the
   `workspaces.catalog` block in the root `package.json`).
2. Run `bun install`. If a version is younger than 7 days, Bun refuses it and
   resolves the newest aged one — that is the rule working, not a bug.
3. Note in the task's `*.todo.md` (`tasks/planning/<task_id>/`) anything the
   gate held back, so a follow-up can pick it up once it has aged.

## Dependabot

`.github/dependabot.yml` opens weekly update PRs (bun workspaces, cargo,
terraform, docker bases). Dependabot brings its own lockfile updates in the
PR, so it is not subject to the release-age gate — review those PRs like any
other change and merge through the normal gates. The 7-day gate still governs
every manual or agent-driven `bun add`/`bun update`.

## Sole exception

**Security fixes.** A release patching a CVE actively exploited against a
version we ship may be adopted immediately, before the 7 days are up: add
the package to `minimumReleaseAgeExcludes` (or pass
`--minimum-release-age 0` for the one install), and note the CVE in the
task todo. Remove the exemption once no longer needed.
