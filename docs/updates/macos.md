# macOS updates and distribution

## Runtime flow

Direct installs use Tauri's signed updater and read the static
`https://github.com/SOUMITRO-SAHA/AgentGauge/releases/latest/download/latest.json`
asset from the latest published GitHub release. When the
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
downloads are GitHub release assets on the public repository. The website
Worker serves only the static site; it has no R2 binding and no download
route.

## Static GitHub Releases distribution

Tauri's updater does not require a backend. It reads a static JSON manifest and
verifies the downloaded archive against the public key embedded in the app;
the release script also binds the release version into that signature
(`tauri signer sign --app-version`), which the updater checks against the
manifest's version.
The release workflow publishes immutable versioned assets and the latest
manifests to a GitHub release on the public repository; the app, website,
Homebrew Cask, and installer reference those release-asset URLs directly. There
is no R2 bucket, CDN, or download proxy. The workflow creates each release as a
draft, uploads its assets, and only then publishes it, so `releases/latest`
never resolves to a partially uploaded release. No EC2 instance, always-on API
server, database, or Redis is needed, so the separate `server/` project is not
used.

Direct and Homebrew installs deliberately use separate installation paths:
the Cask is version-pinned and upgrades through Brew, while direct installs
use the Tauri-signed updater. The Cask does not declare `auto_updates true`,
since Brew-managed copies are not self-updating; normal `brew upgrade --cask`
must be able to find them.

### Install routes

- **Homebrew:** the separate public `homebrew-agentgauge` tap will publish a
  version-pinned Cask for the GitHub release DMG and checksum.
- **Website download:** the site links directly to
  `https://github.com/SOUMITRO-SAHA/AgentGauge/releases/latest/download/AgentGauge-universal.dmg`
  (a stable-name copy of the versioned DMG uploaded with each release).
- **Install script:** `curl -fsSL https://agentgauge.soumitrasaha.com/install.sh |
  sh` detects macOS and its architecture, downloads the versioned DMG from the
  matching GitHub release, verifies its SHA-256 and ad-hoc code signature, then
  installs to the user's `~/Applications` directory without `sudo`. It explains
  how to approve the first launch if Gatekeeper blocks it.

The website hides these routes until the first published release is available.
The installer currently accepts Apple Silicon (`arm64`) and Intel (`x86_64`)
Macs only; it exits with an explicit message on Windows, Linux, and unsupported
architectures. Do not advertise those platforms until their package and
installer paths are implemented and verified.

The installer checks the DMG against a SHA-256 value fetched from the same
GitHub release that hosts the DMG. This detects corruption and mismatched
files, but it does not independently authenticate the publisher or protect
against a compromised release manifest. The embedded ad-hoc signature seals
the app contents but does not identify a trusted developer. The in-app
updater's separate Tauri signature provides publisher-key verification for
updater archives.

GitHub hosts release assets for public repositories at no charge with no
bandwidth limit; each individual asset must be under 2 GiB, and at most 1000
assets may attach to one release. `releases/latest` resolves to the newest
published (non-draft, non-prerelease) release, and the release workflow is the
only creator of releases: it always publishes after uploading, so the
`latest/download` URLs never point at a draft. GitHub enforces asset
immutability protections once a release is published; replacing an asset then
requires a collaborator with write access, and the Homebrew Cask and
installer pin a SHA-256 for each version.

## Cost comparison

**The selected design has no EC2 or always-on backend bill.** Release
artifacts are served by GitHub as release assets on the public repository —
free, with no bandwidth limit — and the website Worker serves only static site
assets, which are also free and unlimited. There is no storage account,
request quota, or egress fee to monitor for downloads. There is no always-on
process, PostgreSQL, Redis, or per-user database.

The costs that may still apply are distribution costs, not updater-server costs:

| Item | Selected GitHub Releases design | EC2-hosted API alternative |
| --- | --- | --- |
| Download requests and bandwidth | GitHub release assets are free and unmetered for public repositories; each file must be under 2 GiB | An EC2 instance is billed while running, even when requests are idle |
| Artifact storage | Free as GitHub release assets (≤1000 assets per release) | EC2 storage and network charges apply; a managed database adds separate charges |
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

GitHub Releases removes the outbound-transfer bill from this comparison
entirely: public-repository release assets are free to store and deliver, with
no per-request or per-gigabyte metering.

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
  public, so release builds cost no plan minutes.
- **The binary files are public downloads:** GitHub serves them as release
  assets on the public repository — free, unmetered, no R2 bucket or AWS S3.
  Only the release workflow creates releases, using the workflow's
  `contents: write` permission; no storage credentials exist to leak.
- **Worker budget:** the Worker serves only static website assets, which are
  free and unlimited. No download traffic reaches it, so the Workers Free plan
  covers the site regardless of download volume.
- **If an EC2 backend is added anyway:** expect a fixed always-on compute and
  networking baseline (about $17.51/month in the example above), plus optional
  Apple membership only if Developer ID signing is adopted. The small number of
  update checks does not remove EC2's hourly baseline. The current design avoids
  that bill entirely.

The selected distribution has **$0/month in storage, request, and egress
charges** — GitHub Releases and the static-assets Worker are both free for a
public repository — and there is no Apple membership cost for the current
ad-hoc route. The illustrative EC2
alternative is about **$210/year** before optional Apple membership, tax,
and other extras. If Developer ID
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

  url "https://github.com/SOUMITRO-SAHA/AgentGauge/releases/download/v#{version}/AgentGauge-#{version}-universal.dmg"
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

1. Add the private Tauri updater key as the `TAURI_SIGNING_PRIVATE_KEY` GitHub
   Actions secret. The local key is at `~/.tauri/agentgauge-updater.key`; the
   key file is not in the repository. The secret must be the key file's exact
   generated content: a single base64 line with no trailing newline. Tauri's
   signer rejects comment lines and trailing newlines (verified against the
   pinned CLI), and the workflow writes the secret verbatim into the file
   `tauri signer` reads. This key decrypts with an empty password and signing
   was verified non-interactive with an empty
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, so no password secret is required.
   The key pair was confirmed on 2026-10-15 by a local sign → verify
   round-trip: `tauri signer sign`, then `minisign -V` against the decoded
   `pubkey` from `app/src-tauri/tauri.conf.json` (its `.pub` matches
   byte-for-byte). Never publish or commit the private key.
2. No Apple Developer account or Apple signing secrets are needed for the
   initial release. The workflow uses ad-hoc signing (`APPLE_SIGNING_IDENTITY=-`
   and `AGENTGAUGE_SIGN_IDENTITY=-`) and does not notarize. Keep that limitation
   visible in release notes, the installer, and the Cask caveat. If Developer ID
   signing is adopted later, update the workflow and add the required Apple
   credentials then; it is an optional cost, not a launch prerequisite.
3. Create the public `homebrew-agentgauge` tap and configure
   `HOMEBREW_TAP_TOKEN` with Contents write access to that repository. The
   release workflow commits the generated version-pinned Cask and DMG checksum
   there. Do not put a placeholder Cask in this app repository.
4. Set the website Actions variable `AGENTGAUGE_DOWNLOADS_ENABLED=true` only
   after the first release's DMG, installer manifest, GitHub release download,
   and tap install have been verified. Then manually run the Deploy Website
   workflow so the new variable is included in the static build. Until then,
   the website continues to show the repository CTA.
5. Bump `app/src-tauri/tauri.conf.json`, `app/package.json`, and
   `app/src-tauri/Cargo.toml` together before creating the release tag. The
   updater workflow intentionally rejects a v0.1.0 release because this feature
    is next-version work under the v0.1.0 feature lock.
6. GitHub release assets must each stay under 2 GiB; the universal DMG and
   updater archive are far below that today, but re-check before dispatching a
   release if bundle sizes grow. Verify the published release's download URLs,
   Gatekeeper approval on a clean Mac, direct in-app update, and actual Brew
   install/upgrade/restart before advertising availability.

The public tap and the Tauri updater private-key secret are configured; the
Homebrew tap token has not been added, and the release workflow
has not been run. Apple signing credentials are not a blocker for the current
ad-hoc distribution route. The app-side update flow is verified with an e2e
fixture; actual GitHub release publication, Gatekeeper approval on a clean Mac,
Homebrew installation, curl installation, and restart into a newer release
remain release-owner checks. The workflow also rejects v0.1.0 under the
existing feature lock; the release owner must choose and set the next release
version.

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
- [GitHub About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
  — storage and bandwidth quotas: 2 GiB per asset, 1000 assets per release,
  no total-size or bandwidth limit.
- [GitHub Linking to releases](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)
  — the `releases/latest/download/<asset>` stable URL used by the updater
  endpoint, installer, and website links.
- [GitHub CLI release commands](https://cli.github.com/manual/gh_release_create)
  — draft → upload → publish flow, `--clobber` re-run behavior, and asset
  label syntax used by the release workflow.
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
  — static asset requests are free and unlimited for the site-only Worker.
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
