# macOS updates and distribution

## Runtime flow

Direct installs use Tauri's signed updater and read the static
`https://agentgauge.soumitrasaha.com/downloads/latest.json`. When the
returning-user shell opens, AgentGauge checks for an update after onboarding has
resolved. If one exists, it downloads and verifies the signed bundle, then asks
the user to restart. The user can defer the restart; Settings → About retains a
restart action. A manual check is also available there. Offline startup checks
stay quiet, while a manual check reports that it could not reach the release
service.

Homebrew-installed copies still check the release feed for availability
but never download the Tauri archive. They ask before running the fixed
`brew upgrade --cask --no-quit --yes --appdir <installed directory>
SOUMITRO-SAHA/agentgauge/agentgauge` command. Only after Homebrew succeeds and
its installed Cask version matches the expected release does AgentGauge offer
Restart. A failed upgrade never offers restart; the user can retry or use
Terminal. No automated startup check invokes Brew.

The updater is macOS-only in the client. The release is a universal app bundle
for Apple Silicon and Intel, and the static manifest maps both updater targets
to the same Tauri-updater-signed archive. The no-paid-account release workflow
uses Apple's ad-hoc code-signing identity (`-`) for the host app and WidgetKit
extension. It does not use a Developer ID certificate and does not notarize the
app or DMG. The updater archive's Tauri signature is independent of Apple's code
signature: it authenticates in-app updates but does not satisfy Gatekeeper.
macOS may block a downloaded app until the user approves it through the
Control-click → Open flow or System Settings → Privacy & Security. Public
downloads use `/downloads/*` on the existing website domain. The website Worker
reads from a private R2 bucket; the bucket is not exposed through a custom R2
domain or an `r2.dev` URL.

## Static CDN distribution

Tauri's updater does not require a backend. It reads a static JSON manifest and
verifies the downloaded archive against the public key embedded in the app;
`requireSignedVersion` also binds the release version into the signed artifact.
The release workflow writes immutable versioned artifacts and the latest
manifests to a private R2 bucket. The app, website, Homebrew Cask, and installer
use `https://agentgauge.soumitrasaha.com/downloads/*`; first-time website
downloads receive the branded CDN URL, not an R2 or GitHub asset URL. The
website Worker uses its R2 binding only to read. R2 bindings are not
permission-restricted to reads; keep Worker code and deployment credentials
protected. Only the release pipeline writes through a scoped Cloudflare token.
No EC2 instance, always-on API
server, database, or Redis is needed, so the separate `server/` project is not
used.

Direct and Homebrew installs deliberately use separate installation paths:
the Cask is version-pinned and upgrades through Brew, while direct installs
use the Tauri-signed updater. The Cask does not declare `auto_updates true`,
since Brew-managed copies are not self-updating; normal `brew upgrade --cask`
must be able to find them.

### Install routes

- **Homebrew:** the separate public `homebrew-agentgauge` tap will publish a
  version-pinned Cask for the CDN DMG and checksum.
- **Website download:** the site links directly to
  `https://agentgauge.soumitrasaha.com/downloads/latest/AgentGauge-universal.dmg`.
- **Install script:** `curl -fsSL https://agentgauge.soumitrasaha.com/install.sh |
  sh` detects macOS and its architecture, downloads the versioned DMG through
  the CDN, verifies its SHA-256 and ad-hoc code signature, then installs to the
  user's `~/Applications` directory without `sudo`. It explains how to approve
  the first launch if Gatekeeper blocks it.

The website hides these routes until the first published release is available.
The installer currently accepts Apple Silicon (`arm64`) and Intel (`x86_64`)
Macs only; it exits with an explicit message on Windows, Linux, and unsupported
architectures. Do not advertise those platforms until their package and
installer paths are implemented and verified.

The installer checks the DMG against a SHA-256 value fetched from the same CDN
that hosts the DMG. This detects corruption and mismatched files, but it does not
independently authenticate the publisher or protect against a compromised CDN
manifest. The embedded ad-hoc signature seals the app contents but does not
identify a trusted developer. The in-app updater's separate Tauri signature
provides publisher-key verification for updater archives.

Keep the R2 bucket private and disable its development URL (`r2.dev`). The
website Worker's `/downloads/*` route is the public download surface; the bucket
API endpoint and write credentials must never be embedded in the app, website,
Homebrew Cask, or installer. The Worker only accepts GET and HEAD requests and
streams object metadata and byte ranges from R2. The Cache API caches successful
full GET responses for immutable versioned artifacts (up to 512 MiB) and the
short-lived first-download DMG alias. Range/conditional requests and mutable
manifests bypass the edge cache; a matching strong `If-Range` ETag supports
resuming downloads, while a stale validator restarts with the full object.
Cloudflare's Cache API is local to the edge data center, not globally replicated.

## Cost comparison

**The selected design has no EC2 or always-on backend bill.** A small edge
Worker maps `/downloads/*` requests to a private R2 bucket; the rest of the site
is served as static assets. Workers Free includes 100,000 Worker invocations per
day, and static asset requests are free and unlimited. The optional Workers Paid
plan costs $5/month and includes 10 million Worker requests and 30 million CPU
milliseconds per month. R2 includes 10 GB-month of standard storage, 1 million
Class A operations, and 10 million Class B operations per month, with no
internet egress fee. Within those allowances, storage and request costs can be
$0/month. Above them, usage is billed; this is low-cost, not unlimited free
hosting. There is no always-on process, PostgreSQL, Redis, or per-user database.

The costs that may still apply are distribution costs, not updater-server costs:

| Item | Selected R2 + Cloudflare CDN design | EC2-hosted API alternative |
| --- | --- | --- |
| Download Worker requests | Workers Free includes 100,000 requests/day; Workers Paid is $5/month with 10 million requests/month included, then $0.30/million. Static website asset requests are free and unlimited. | An EC2 instance is billed while running, even when requests are idle |
| Artifact storage and R2 reads | First 10 GB-month, 1 million Class A, and 10 million Class B operations are included; then $0.015/GB-month for standard storage, $4.50/million Class A, and $0.36/million Class B. Edge cache hits for full artifacts avoid R2 reads; misses, ranges, and manifests still read R2. | EC2 storage and network charges apply; a managed database adds separate charges |
| Internet egress | R2 and Workers have no egress fee for downloads through the website Worker path | AWS internet transfer may be billed after its allowance; EC2 still has an hourly baseline |
| Database and cache | None | PostgreSQL could run on the same EC2 host, but uses its RAM/disk and needs backups; a managed database costs extra. Redis is not needed for this low-volume check |
| Release build | Standard GitHub-hosted runners are free and unlimited for public repositories; private repositories use plan quotas and may incur charges after them | The same build cost applies if GitHub Actions is retained; moving the API to EC2 does not remove release-build costs |
| macOS signing and notarization | $0 for the current ad-hoc-signed, non-notarized release; users may need to approve first launch. Developer ID signing and notarization are optional future improvements and require Apple Developer Program membership (USD $99/year; regional pricing may differ) | EC2 does not change the current ad-hoc route; optional Developer ID signing has the same Apple membership cost |
| Homebrew tap | A public tap hosted on GitHub adds no server requirement | Still optional; an EC2 backend does not make Homebrew itself necessary |

### What the EC2 option might cost

For a concrete but deliberately small example, assume one Linux `t4g.small`
instance in `us-east-1`, left on for a 730-hour month, with a 20 GB `gp3` EBS
volume and one public IPv4 address. The EC2 instance figure is a point-in-time
public price snapshot; it is not an AWS quote:

| AWS line item | Example calculation | Approximate monthly cost |
| --- | --- | ---: |
| EC2 `t4g.small` compute | $0.0168/hour × 730 hours | $12.26 |
| EBS `gp3` volume | $0.08/GB-month × 20 GB | $1.60 |
| Public IPv4 address | $0.005/hour × 730 hours | $3.65 |
| **Illustrative subtotal** | Before snapshots, monitoring, extra data transfer, taxes, or support | **$17.51/month** |

That is roughly **$210 per year** after temporary credits, before optional Apple
Developer membership if Developer ID signing is added later. It is a price
illustration, not an AWS quote: rates vary by region and change, and a 2 GiB
`t4g.small` may be tight for running both Bun and PostgreSQL. A production
deployment may need a larger instance, more storage, backups, monitoring, and a
recovery plan. A separate RDS database or cache adds separate hourly and storage
charges; a Multi-AZ database adds more. Use the AWS Pricing Calculator for the
selected region and design before creating resources.

R2 and Workers remove the outbound-transfer bill from this comparison. The
download Worker caches successful full artifact responses per edge data center,
so repeat full downloads at that edge avoid R2 reads; misses, partial downloads,
and manifest requests still read R2. All download requests still invoke the
Worker and count toward its request limit.

AWS currently advertises up to 750 free `t4g.small` instance-hours per month
through **December 31, 2026**. Eligibility and region restrictions apply, and
this temporary compute offer does not make the disk, public IPv4 address,
backups, or future months automatically free. Do not use it as the long-term
budget assumption.

### Practical budget for this project

- **No Apple account is required for the initial release:** the app and widget
  use ad-hoc code signing, and the updater archive uses its separate Tauri
  signing key. Users must be told that the app is not notarized and may need
  manual Gatekeeper approval on first launch. This reduces cost but adds
  installation friction and does not provide a Developer ID publisher identity.
- **Optional later signing upgrade:** Apple Developer Program membership is
  USD $99/year (regional pricing may differ) for Developer ID signing and
  notarization. There is no separate per-release Apple notarization fee.
- **GitHub Actions:** public-repository runner usage is free; this repository is
  currently private, so its runner use is subject to the plan's included minutes
  and any overage rates.
- **The binary files are public downloads:** the website Worker exposes them at
  `https://agentgauge.soumitrasaha.com/downloads/*`; there is no separate R2
  public domain or AWS S3 URL. The R2 bucket stays private, and only the release
  workflow writes to it. The source repository can stay private because the
  updater no longer fetches GitHub release assets.
- **Worker budget:** download requests invoke the Worker, while ordinary static
  website assets remain free and unlimited. The Free plan allows 100,000 Worker
  requests/day, shared across the account; the $5/month Paid plan includes 10
   million/month. Edge hits avoid R2 reads; uncached requests draw from R2's
   10-million monthly Class B allowance. Monitor request volume before
  choosing a Paid plan.
- **If an EC2 backend is added anyway:** expect a fixed always-on compute and
  networking baseline (about $17.51/month in the example above), plus optional
  Apple membership only if Developer ID signing is adopted. The small number of
  update checks does not remove EC2's hourly baseline. The current design avoids
  that bill entirely.

Within R2's and Workers Free's included allowances, the selected distribution
has **$0/month in storage, request, and egress charges** and no Apple membership
cost for the current ad-hoc route. If traffic requires Workers Paid, its base
cost is **$5/month** with 10 million requests included. The illustrative EC2
alternative is about **$210/year** before optional Apple membership, tax,
private-repository GitHub Actions overages, and other extras. If Developer ID
signing is added later, budget another USD $99 per year.

This cost comparison is a snapshot checked on October 13, 2026. AWS prices,
GitHub plan allowances, and Apple's local-currency prices can change; recalculate
before publishing or provisioning.

## Homebrew

AgentGauge detects a Brew-managed installation by requiring the running app
bundle to resolve to the installed `agentgauge` Cask's app artifact under the
Homebrew Caskroom. A direct copy uses the Tauri updater. A Brew-managed copy
checks the release feed but asks before spawning the named Homebrew upgrade
on a background thread. The fixed command preserves the app directory and uses
`--no-quit` so Brew does not close the running app; it cannot offer restart
until Brew reports the expected version. The Cask does not declare
`auto_updates true`, since Brew-installed copies do not install their own
updates. A normal `brew upgrade --cask` works as well.

Install from the future public tap with:

```sh
brew install --cask --appdir="$HOME/Applications" SOUMITRO-SAHA/agentgauge/agentgauge
```

The Cask belongs in the separate `homebrew-agentgauge` tap repository, not in
this application repository. Its release-specific values come from the
versioned DMG and `latest-macos.json` checksum:

```ruby
cask "agentgauge" do
  version "0.2.0"
  sha256 "<SHA-256 from the release checksum file>"

  url "https://agentgauge.soumitrasaha.com/downloads/v#{version}/AgentGauge-#{version}-universal.dmg"
  name "AgentGauge"
  desc "Usage monitor for AI coding harnesses"
  homepage "https://agentgauge.soumitrasaha.com"

  app "AgentGauge.app"
end
```

The version and checksum must be bumped in the tap for each published version.
The Cask file is intentionally not checked into this repository: no tap
repository is present here, and a placeholder checksum would not be installable
or safe. `brew upgrade --cask SOUMITRO-SAHA/agentgauge/agentgauge` is the
Terminal fallback when the app cannot complete an upgrade.
The generated Cask warns that the initial build is ad-hoc signed and not
notarized. Homebrew's default quarantine is intentionally retained; do not
install with `--no-quarantine` to hide the Gatekeeper warning. Users may need to
Control-click AgentGauge.app and choose Open, or approve it in System Settings →
Privacy & Security.

## Release setup and remaining gates

The release workflow is manually dispatched from `main` with an existing
version tag. It requires the tag to point at the exact protected-main commit
running the workflow, then builds and signs that code, publishes the versioned
assets, updates the latest manifests, and commits the Homebrew Cask. This is an
explicit release action: merely pushing a tag does not publish binaries or
change the in-app updater feed. Before the first release can be published:

1. Create a private R2 bucket named `agentgauge-releases`. Do not connect a
   separate R2 custom domain, and disable the bucket's `r2.dev` URL. The existing
   website Worker exposes its objects under
   `https://agentgauge.soumitrasaha.com/downloads/*` through the `RELEASES`
   binding in `website/wrangler.jsonc`; versioned objects are immutable and
   latest aliases carry a short cache lifetime.
2. Give the release workflow a Cloudflare API token with R2 object-write access,
   set `CLOUDFLARE_ACCOUNT_ID`, and set the Actions variable
   `AGENTGAUGE_RELEASES_BUCKET` to `agentgauge-releases` so it matches the
   Worker's R2 binding. The website deploy token also needs its existing Workers
   deploy permissions.
3. Add the private Tauri updater key as the `TAURI_SIGNING_PRIVATE_KEY` GitHub
   Actions secret. The local key is at `~/.tauri/agentgauge-updater.key`; the
   key file is not in the repository. The generated key has no password, so
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` may remain unset. Never publish or
   commit the private key.
4. No Apple Developer account or Apple signing secrets are needed for the
   initial release. The workflow uses ad-hoc signing (`APPLE_SIGNING_IDENTITY=-`
   and `AGENTGAUGE_SIGN_IDENTITY=-`) and does not notarize. Keep that limitation
   visible in release notes, the installer, and the Cask caveat. If Developer ID
   signing is adopted later, update the workflow and add the required Apple
   credentials then; it is an optional cost, not a launch prerequisite.
5. Create the public `homebrew-agentgauge` tap and configure
   `HOMEBREW_TAP_TOKEN` with Contents write access to that repository. The
   release workflow commits the generated version-pinned Cask and DMG checksum
   there. Do not put a placeholder Cask in this app repository.
6. Set the website Actions variable `AGENTGAUGE_DOWNLOADS_ENABLED=true` only
   after the first DMG, installer manifest, `/downloads/*` Worker route, and tap
   install have been verified. Then manually run the Deploy Website workflow so
   the new variable is included in the static build. Until then, the website
   continues to show the repository CTA.
7. Bump `app/src-tauri/tauri.conf.json`, `app/package.json`, and
   `app/src-tauri/Cargo.toml` together before creating the release tag. The
   updater workflow intentionally rejects a v0.1.0 release because this feature
    is next-version work under the v0.1.0 feature lock.
8. Build the final universal DMG and updater archive before publication: the
   current Wrangler CLI's `r2 object put` limit is 315 MB per file. If either
   exceeds that limit, change the upload transport before dispatching a release.
   Verify the public CDN alias, versioned artifact, Gatekeeper approval on a
   clean Mac, direct in-app update, and actual Brew install/upgrade/restart before
   advertising availability.

The R2 bucket/domain, public tap, Cloudflare credentials, Homebrew tap token,
and Tauri updater private key are not configured here, and the release workflow
has not been run. Apple signing credentials are not a blocker for the current
ad-hoc distribution route. The app-side update flow is verified with an e2e
fixture; actual R2 publication, Gatekeeper approval on a clean Mac, Homebrew
installation, curl installation, and restart into a newer release remain
release-owner checks. The workflow also rejects v0.1.0 under the existing
feature lock; the release owner must choose and set the next release version.

## Sources

- [Tauri updater plugin](https://v2.tauri.app/plugin/updater/) — signed updater
  artifacts, static JSON format, check/download/install API, and relaunch
  behavior.
- [Tauri DMG distribution](https://v2.tauri.app/distribute/dmg/) and
  [macOS signing/notarization](https://v2.tauri.app/distribute/sign/macos/)
  — DMG generation and signed distribution requirements.
- [OpenCode macOS install instructions](https://github.com/anomalyco/opencode/blob/055d95bb7e278c94baf06235a52cac79dd13ba67/README.md#L67-L82)
  and [desktop updater controller](https://github.com/anomalyco/opencode/blob/055d95bb7e278c94baf06235a52cac79dd13ba67/packages/desktop/src/main/updater-controller.ts)
  — Homebrew installation is distinct from the desktop's in-app check/download/install flow.
- [Homebrew Cask Cookbook](https://docs.brew.sh/Cask-Cookbook#stanza-auto_updates)
  and [Homebrew FAQ](https://docs.brew.sh/FAQ#how-does-brew-upgrade-handle-apps-that-update-themselves)
  — `auto_updates true` and version-aware handling of self-updating apps.
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
  — included storage/operation allowances and no egress fee.
- [Workers Static Assets routing](https://developers.cloudflare.com/workers/static-assets/routing/)
  and [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/)
  — route only `/downloads/*` through the Worker and read private bucket objects.
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
  — Free/Paid request limits, the $5/month minimum, and static asset billing.
- [Wrangler R2 object commands](https://developers.cloudflare.com/workers/wrangler/commands/r2/)
  — release workflow upload behavior and disabling the `r2.dev` URL.
- [Tauri macOS signing and notarization](https://v2.tauri.app/distribute/sign/macos/)
  — ad-hoc signing (`-`) and the remaining first-launch approval when no Apple-
  authenticated signing identity is used.
- [Apple Developer Program membership](https://developer.apple.com/programs/whats-included/)
  — annual membership fee and Developer ID access.
- [Apple notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
  — signing protections required for notarized macOS distribution.
- [GitHub Actions billing](https://docs.github.com/en/actions/administering-github-actions/usage-limits-billing-and-administration)
  and [runner selection](https://docs.github.com/en/actions/using-jobs/choosing-the-runner-for-a-job)
  — public-runner availability and private-repository quotas.
- [AWS EC2 On-Demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/),
  [T4g instance pricing and trial](https://aws.amazon.com/ec2/instance-types/t4/),
  [EBS pricing](https://aws.amazon.com/ebs/pricing/), and
  [VPC public IPv4 pricing](https://aws.amazon.com/vpc/pricing/) — EC2 example
  cost components and the temporary T4g offer.
- [AWS Pricing Calculator](https://calculator.aws/) — re-estimate a chosen
  region, instance, storage, and traffic profile.
- [Vantage t4g.small price snapshot](https://instances.vantage.sh/aws/ec2/t4g.small)
  — source for the illustrative $0.0168/hour us-east-1 compute figure; confirm
  the current quote in AWS Pricing Calculator.
