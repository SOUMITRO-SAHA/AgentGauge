# Astro Rules (website — future)

Applies **only** to `website/`, the reserved Astro landing page and
documentation site.

## Status: not initialised

`website/` currently contains a single `README.md`. **There is no Astro project,
no `package.json`, no `astro.config.*`, and no dependencies** — so nothing in
this file is actionable yet.

- Do not scaffold, install, or configure Astro unless the user asks for it.
- Until then, do not invent files, paths, or config in `website/`, and do not
  describe the site as existing.
- A previous version of this rule documented an `astro dev --background`
  command and `astro dev stop|status|logs` subcommands. **Those are not real
  Astro commands** — do not use them.

## Isolation from the app (binding)

- `website/` is a **separate project with its own `package.json` and its own
  lockfile**. It is not part of the Tauri build, not a workspace member of
  `app/`, and its dependencies never enter the desktop bundle.
- Never add website paths to `app/vite.config.ts`, `app/tsconfig.json`, or
  `app/components.json`. Never import from `website/` into `app/`.
- All Tauri configuration and code lives under `app/` (`AGENTS.md`).
- Do not copy `app/bun.lock`, share a `node_modules`, or hoist website
  dependencies into the app.

## When it is initialised

Stack decisions to confirm with the user before writing code: Astro version,
static vs hybrid output, Tailwind 4 integration (matching the app's approach),
and content collections for docs. Prefer a **separate** toolchain from
`app/` — do not make the two projects share tsconfig, ESLint, or formatters.

## Development

Once scaffolded, the normal Astro workflow applies:

```sh
cd website
bun install
bun run dev      # vite dev server
bun run build    # astro build
bun run preview  # serve the production build
```

Run the dev server as a background task when you need to keep it alive, and
stop it when the task ends — do not leave an orphaned server holding a port.

## Documentation

Full documentation: <https://docs.astro.build>

Consult before working on related tasks:

- [Pages, dynamic routes, middleware](https://docs.astro.build/en/guides/routing/)
- [Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Framework components (React, Vue, Svelte)](https://docs.astro.build/en/guides/framework-components/)
- [Content collections](https://docs.astro.build/en/guides/content-collections/)
- [Styling and Tailwind](https://docs.astro.build/en/guides/styling/)
- [Internationalization](https://docs.astro.build/en/guides/internationalization/)

Consult [`seo.md`](seo.md) for the SEO gate that applies once pages exist.