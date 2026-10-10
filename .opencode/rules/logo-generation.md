# Logo & Icon Generation

Applies to any generated or revised app mark, icon, or brand asset for this
project (AgentGauge).

## Current brand status — read this first

**No brand is defined yet.** The mark in `app/src-tauri/icons/` is the stock
Tauri placeholder, and no colour tokens are pinned in `src/index.css`
(they are the shadcn `neutral` defaults). Therefore:

- Do **not** invent brand colours, logomarks, or a tagline and treat them as
  decided. If a task needs brand direction, propose options and get the user's
  choice before generating assets.
- Once the user picks a direction, **record the decision** (name, colours as
  `oklch`/hex, clear space) in this file so every later asset is consistent,
  and wire the colours into `src/index.css` `@theme inline` so the UI follows.
- Do not restate another project's brand values. Brand tokens for this app are
  whatever the user chooses here — nothing else applies.

## Design constraints (unless the user overrides)

- Flat, geometric, minimal. No gradients, glow, drop shadows, 3D bevels,
  outlines-on-outline, or text baked into the mark. It must survive a 16px
  render and a monochrome OS theme.
- Legible at 16px: test the mark at every size that will ship, not just large.
- Works on light and dark backgrounds (the app supports both) and on all three
  target OSes' window chrome.
- Meaningful to the product: subscriptions, usage, limits, and status
  visibility — not a generic AI brain/robot/sparkle cliché.

## Tauri's icon contract (the part tools enforce)

The icon set is a **platform packaging contract**. A rename or omission breaks
`bun run tauri build` on the affected OS.

`app/src-tauri/tauri.conf.json` → `bundle.icon` requires exactly:

```text
icons/32x32.png          icons/128x128.png      icons/128x128@2x.png
icons/icon.icns          icons/icon.ico
```

The same directory must also carry the Windows Store set:

```text
Square30x30Logo.png   Square44x44Logo.png   Square71x71Logo.png
Square89x89Logo.png   Square107x107Logo.png Square142x142Logo.png
Square150x150Logo.png Square284x284Logo.png Square310x310Logo.png
StoreLogo.png
```

- Deliver the **whole** set when the brand changes — never a single size. A
  partially regenerated set ships inconsistent icons on one platform.
- Generate the source at high resolution and downscale; never upscale. Verify
  each PNG is a valid, non-empty file of the stated dimensions.
- `.icns` and `.ico` are containers — build them properly rather than renaming a
  PNG. Use the standard Tauri tooling (`bun run tauri icon <source>`) to
  regenerate the set; that is the reliable path and it keeps every required
  size in sync.
- Do not commit raw working files, design-tool exports, or a single "logo.png"
  outside the icons directory. Keep sources out of the repo unless the user
  wants them tracked.
- OS/browser caches are aggressive: after regenerating, verify on a **built**
  app (`bun run tauri build`), not only `tauri dev`, and re-check after a
  platform icon-cache reset if the old mark appears.

## Delivery checklist

1. Inspect the current reference asset before generating or revising anything.
2. Confirm the chosen direction with the user if the brand is still undefined.
3. Generate with the built-in image tooling; inspect at full size **and** at
   16/32/128px, on light and dark.
4. Regenerate the complete set via `bun run tauri icon`; verify every file in
   the two lists above exists and is valid.
5. Update `productName` in `tauri.conf.json` and the `<title>` in
   `app/index.html` if the name changed — and remember `index.html` still
   carries the Tauri starter title.
