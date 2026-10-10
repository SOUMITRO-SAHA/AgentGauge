# Logo & Icon Generation

Applies to any generated or revised app mark, icon, or brand asset for this
project (AgentGauge).

## Adopted brand direction — AgentGauge

The user rejected the prior colorful gauge mark and directed a **monochrome SVG**
revision on 2026-10-10. The current master SVG is a geometric `A` monogram with a
segmented crossbar suggesting measured usage. It uses one neutral foreground
color per color scheme on a transparent canvas: graphite (`#17191D`) for light
scheme and near-white (`#F4F4F5`) for dark scheme. Do not add a background tile
to the master SVG. Native desktop icons are a separate composition using only
the approved monochrome theme: a brand ink (`#111827`) plate and a near-white
(`#F4F4F5`) A mark, including its segmented meter bars. Do not add a
teal accent to this icon theme.

### The desktop plate follows Apple's macOS icon grid

On 2026-10-10 the user directed that the desktop icon stop rendering larger than
its Dock neighbours. The plate is drawn on the grid macOS itself uses, measured
from the system app icons on this machine rather than assumed — every native icon
fills the same 206 of every 256 pixels of its canvas:

| Property | Value | Measured from |
| --- | --- | --- |
| Canvas | 1024 x 1024 | Apple HIG layout size |
| Opaque body | 824 x 824 | 0.8047 of the canvas |
| Inset | 100 px per side | 25/256 |
| Corner radius | 211 px | 0.256 of the body width |
| Corner exponent | 2.4 | fitted to the system icons' corner profile |

The Dock draws the stored artwork rather than masking it, so the shape has to be
authored here. A full-bleed square renders larger than every neighbouring icon
and with sharp corners — that is the whole defect, and it is why the plate is a
path rather than a `rect`.

**Keep the mark's proportion inside the plate unchanged when the grid changes.**
The source is scaled into the body rather than redrawn, so the monogram and its
segmented crossbar stay exactly as approved. The mark currently clears the plate
edge by 11% per side, just under the 12% below; that ratio comes from
`logo.svg`, and shrinking the mark is a brand change that needs the user.

- Name: **AgentGauge**. Descriptor remains “A local usage and status dashboard
  for AI coding tools.”
- Keep clear space around the mark of at least 12% of its canvas. Preserve the
  monogram and segmented crossbar at small sizes; do not add text.

The monochrome master SVG revision does not change the app's UI theme tokens.
The desktop icon generator adds its background only to a temporary SVG and then
uses Tauri to generate the complete packaged icon set. Do not change the mark
direction without confirming with the user. Do not restate another project's
brand values.

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
   16/32/128px, on light and dark. If that tooling is unavailable, disclose the
   limitation and use the simplest reproducible vector fallback rather than
   silently substituting an unreviewed raster generator.
4. Regenerate the complete set via `bun run tauri icon`; verify every file in
   the two lists above exists and is valid.
5. Update `productName` in `tauri.conf.json` and the `<title>` in
   `app/index.html` if the name changed — and remember `index.html` still
   carries the Tauri starter title.
