# SEO Rules (website — future)

The SEO standard for the Astro landing/docs site, **compressed to a summary**.
The full engineering standard (~48KB, ~120 numbered sections) is deliberately
**not** kept here: it costs ~12k tokens in every session for a site that does
not exist yet.

## Activation trigger

**Do not apply this file until `website/` contains an initialised Astro
project.** Before that it is inert reference material — see
[`astro.md`](astro.md).

When the site *is* initialised, either:

- restore the full standard from its source of record (re-author or recover it
  from history), or
- treat this summary as the checklist and expand only the sections a task
  actually touches.

Whichever you choose, keep `website/` validation in the definition of done in
[`testing.md`](testing.md).

## Non-negotiables (the 80/20)

**Architecture**

- HTML-first, static-first. Every public page must deliver complete, semantic,
  useful HTML **without** client-side JavaScript.
- Content lives in the initial HTML response. Anything that only appears after
  hydration does not exist for a crawler or a no-JS user.
- Zero-framework-JS by default: `.astro` components, layouts, slots, content
  collections, `astro:assets`. No React/Vue/Svelte islands unless a page
  genuinely requires one, and then only for that island.

**Per page**

- Exactly one `<h1>`, and a sane heading hierarchy — no skipped levels.
- A unique, descriptive `<title>` (≈50–60 chars) and meta description
  (≈150–160 chars), both containing the page's actual subject.
- Canonical URL on every page, plus correct `og:` / `twitter:` tags.
- Meaningful `<img alt>` for every content image; decorative images get `alt=""`.
- Semantic elements (`header`, `nav`, `main`, `article`, `footer`) instead of
  styled `<div>`s.

**Site level**

- `sitemap.xml` via `@astrojs/sitemap`, generated from the real routes.
- `robots.txt`; staging/preview deployments are **`noindex`**, never
  indexable.
- Internal links use descriptive anchor text, and **no orphan pages** — every
  page is reachable from navigation within a few clicks.
- `404` for genuinely missing content, and a redirect for moved content.
  Astro static output does not redirect by default — configure it explicitly.

**Performance (this is a ranking factor, not a nice-to-have)**

- Serve `astro:assets`-optimised images with explicit `width`/`height` (CLS).
- Never use a CSS background for an indexable or LCP image.
- Inline critical CSS / avoid render-blocking work; the whole point of static
  output is that it is fast.
- Respect `prefers-reduced-motion`; do not ship autoplaying video by default.

**Structured data**

- JSON-LD (`Organization` + `WebSite` on the homepage at minimum; `Article`
  for blog posts). Every claim in structured data must be visibly true on the
  page — mismatches are a manual-action risk, not a shortcut.

## Per-task gate

```sh
cd website
bun run build      # must complete with no warnings
bunx astro check   # 0 errors, 0 warnings
```

Validate rendered HTML (head tags, heading order, canonical, sitemap) rather
than trusting the template. Keep the site static-only: no secrets or private
URLs client-side, and no third-party scripts without justification (also
[`security.md`](security.md)).