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
