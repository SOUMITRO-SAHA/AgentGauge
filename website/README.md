# AgentGauge website

The AgentGauge marketing site: a single landing page, built with
[Astro](https://astro.build) and Tailwind CSS, deployed to Cloudflare.

This directory is independent of the Tauri app in `app/`. It never imports app
code and is never part of the app build.

## Stack

- **Astro 7** with `output: 'static'` — the whole page is prerendered HTML.
- **Tailwind CSS 4** via `@tailwindcss/vite`, with no Tailwind config file.
  Theme tokens live in `src/styles/global.css` under `@theme`, mirroring
  `app/src/index.css` so the site and the product share one visual language.
- **Phosphor** icons, inlined as SVG path data by `bun run icons:generate`
  rather than loaded as a webfont.
- **Wrangler** deploying to a Cloudflare Worker that serves `dist/` as static
  assets.

## Commands

```sh
cd website
bun install
bun run dev            # Local dev server on :4321
bun run build          # Production build into dist/
bun run check          # astro check (types + template diagnostics)
bun run preview        # Serve the production build locally
bun run icons:generate # Regenerate src/data/icons.ts from @phosphor-icons/core
bun run deploy         # astro build && wrangler deploy
```

## Deployment

The site deploys as a Cloudflare Worker with static assets. `wrangler.jsonc`
points the Worker at `./dist`, so there is no server runtime and no
`@astrojs/cloudflare` adapter.

```sh
cd website
bun run deploy
```

That publishes to the Worker named `agentgauge-website` on your Cloudflare
account. The custom domain is attached once, in the dashboard:

1. **Workers & Pages** → **agentgauge-website** → **Settings** → **Domains & Routes**
2. **Add** → **Custom domain** → `agentgauge.soumitrasaha.com`

The subdomain must already have DNS for `soumitrasaha.com` pointed at
Cloudflare. Until the custom domain is added, the Worker answers on
`*.workers.dev`.

## macOS downloads

The public site hosts `public/install.sh` at `/install.sh`. After the first
published release and a successful Homebrew tap publication, set the GitHub Actions
repository variable `AGENTGAUGE_DOWNLOADS_ENABLED` to `true` to show the direct
DMG, Homebrew, and `curl` install options. It defaults to false so the site does
not advertise downloads before artifacts exist. After changing the variable,
manually run the Deploy Website workflow to rebuild the static site.

The release workflow is manually dispatched from `main` with a version tag that
must point to that exact commit; pushing a tag alone does not publish artifacts
or advance the updater feed. Protect `main` and release tags with the repository's
normal review/ruleset policy. The DMG and Tauri updater files are stored in the
private `agentgauge-releases` R2 bucket and served by the existing website Worker
at `https://agentgauge.soumitrasaha.com/downloads/*`. The bucket's `r2.dev` URL
stays disabled; the bucket itself is not public. The Worker routes downloads to
R2 and serves other requests from static assets. The installer currently accepts
macOS Apple Silicon and Intel only and verifies the release
manifest, SHA-256, and ad-hoc code signature before copying the app to
`~/Applications`. It is not notarized: macOS may block the first launch, so users
may need to Control-click the app and choose Open, or approve it in System
Settings → Privacy & Security. The CDN-hosted checksum detects transfer
corruption but does not independently authenticate the publisher.

The Worker preserves the objects' `Cache-Control`, ETag, and byte-range metadata
for downloads. The configured bucket name in `website/wrangler.jsonc` must match
the `AGENTGAUGE_RELEASES_BUCKET` Actions variable used by the release workflow.

Homebrew installs are intended for the same per-user directory:
`brew install --cask --appdir="$HOME/Applications" SOUMITRO-SAHA/agentgauge/agentgauge`.
The release workflow needs a public `SOUMITRO-SAHA/homebrew-agentgauge` tap and
a `HOMEBREW_TAP_TOKEN` with Contents write access to publish the generated Cask.

Run `bun run test` and `bun run test:installer` to validate the download gate
and installer platform guard.

### Continuous deployment

`.github/workflows/deploy-website.yml` builds and deploys on every push to
`main`. It needs two repository secrets:

| Secret              | Purpose                          |
| ------------------- | -------------------------------- |
| `CLOUDFLARE_API_TOKEN` | Workers deploy token           |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account id    |

## Content and claims

Page content lives in `src/data/content.ts`; site metadata (name, description,
repository, licence) lives in `src/config/site.ts`.

The copy is deliberately conservative, because it describes a product that is
still in early access:

- **macOS is the only shipped platform.** Windows and Linux are presented as
  "coming soon", never as supported.
- **A usage window cannot be restarted by a prompt.** The automation follows the
  reset the provider reports and spends quota; it does not verify a rollover.
- **A harness appears in the capability matrix only once it has actually been
  read.** Planned integrations are labelled `Planned`, never implied as shipped.

Keep those three rules intact when editing the copy. `docs/PRD.md` is the source
for product scope, and the app's own `README.md` is the source for what is
implemented today.
