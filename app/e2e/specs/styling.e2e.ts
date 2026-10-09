import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, browser } from "@wdio/globals";

// Repo-root `.temp/e2e`, resolved from this file so the path holds regardless
// of the working directory the runner was launched from.
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const shotDir = path.join(repoRoot, ".temp", "e2e");
fs.mkdirSync(shotDir, { recursive: true });

type RGBA = [number, number, number, number];

type Computed = {
  // Self-check of the colour converter: it must round-trip a known rgb value.
  converterOk: boolean;
  // Raw computed strings, kept for readable failure messages.
  raw: {
    backgroundToken: string;
    primaryToken: string;
    bodyBackground: string;
  };
  backgroundToken: RGBA;
  primaryToken: RGBA;
  bodyBackground: RGBA;
  bodyBoxSizing: string;
  bodyFontFamily: string;
  fontSansUtility: string;
  button: {
    exists: boolean;
    background?: RGBA;
    color?: RGBA;
    boxSizing?: string;
    height?: string;
    variant?: string | null;
    size?: string | null;
  };
  logoRow: { exists: boolean; display?: string };
};

/**
 * Reads the values the engine actually resolved in the native webview.
 *
 * WKWebView returns modern colour functions (`oklch(...)`) verbatim from
 * `getComputedStyle` rather than converting to `rgb()`, so colours are
 * normalised through a canvas instead of being string-parsed.
 */
function readComputed(): Promise<Computed> {
  return browser.execute(() => {
    const toRgba = (color: string): number[] => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d");
      if (!ctx) return [-1, -1, -1, -1];
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000000";
      // An unparseable value leaves fillStyle on the previous assignment.
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    };

    // A custom property only yields a colour if the theme actually defined it,
    // so this distinguishes "token present" from "token missing" instead of
    // collapsing both to fully transparent.
    const resolveToken = (token: string): string => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = `var(${token})`;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return value;
    };

    // `font-sans` must resolve to the project's stack. It is probed inside a
    // monospace parent so that a *missing* utility inherits monospace and is
    // distinguishable from one that genuinely resolves — without this, an
    // ungenerated utility would silently inherit the body font and pass.
    const host = document.createElement("div");
    host.style.fontFamily = "monospace";
    const probe = document.createElement("span");
    probe.className = "font-sans";
    probe.textContent = "probe";
    host.appendChild(probe);
    document.body.appendChild(host);
    const fontSansUtility = getComputedStyle(probe).fontFamily;
    host.remove();

    const btn = document.querySelector('button[data-slot="button"]');
    const row = document.querySelector('[data-testid="logo-row"]');
    const body = getComputedStyle(document.body);

    const backgroundTokenRaw = resolveToken("--background");
    const primaryTokenRaw = resolveToken("--primary");
    const bodyBackgroundRaw = body.backgroundColor;

    return {
      converterOk: toRgba("rgb(12, 34, 56)").join(",") === "12,34,56,255",
      raw: {
        backgroundToken: backgroundTokenRaw,
        primaryToken: primaryTokenRaw,
        bodyBackground: bodyBackgroundRaw,
      },
      backgroundToken: toRgba(backgroundTokenRaw),
      primaryToken: toRgba(primaryTokenRaw),
      bodyBackground: toRgba(bodyBackgroundRaw),
      bodyBoxSizing: body.boxSizing,
      bodyFontFamily: body.fontFamily,
      fontSansUtility,
      button: btn
        ? {
            exists: true,
            background: toRgba(getComputedStyle(btn).backgroundColor),
            color: toRgba(getComputedStyle(btn).color),
            boxSizing: getComputedStyle(btn).boxSizing,
            height: getComputedStyle(btn).height,
            variant: btn.getAttribute("data-variant"),
            size: btn.getAttribute("data-size"),
          }
        : { exists: false },
      logoRow: row
        ? { exists: true, display: getComputedStyle(row).display }
        : { exists: false },
    };
  }) as Promise<Computed>;
}

const same = (a: RGBA, b: RGBA) => a.every((v, i) => v === b[i]);
const opaque = (c: RGBA) => c[3] === 255;
const luminance = (c: RGBA) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

describe("Tailwind + shadcn setup", () => {
  it("resolves colours to rgba for comparison", async () => {
    // Guards every numeric assertion below: without this, a converter that
    // silently fails would read as "transparent everywhere".
    const s = await readComputed();
    expect(s.converterOk).toBe(true);
  });

  it("defines the shadcn theme tokens at runtime", async () => {
    const s = await readComputed();

    expect(opaque(s.backgroundToken)).toBe(true);
    expect(opaque(s.primaryToken)).toBe(true);
    expect(s.raw.backgroundToken).not.toBe("");
    expect(s.raw.primaryToken).not.toBe("");
  });

  it("applies Tailwind preflight and the base layer to <body>", async () => {
    const s = await readComputed();

    // Preflight's universal border-box reset.
    expect(s.bodyBoxSizing).toBe("border-box");
    // `@apply bg-background text-foreground` resolving to the theme token.
    expect(opaque(s.bodyBackground)).toBe(true);
    expect(same(s.bodyBackground, s.backgroundToken)).toBe(true);
  });

  it("defines the project font through @theme so font-sans resolves", async () => {
    const s = await readComputed();

    // The font must live in `@theme`, not on `:root`, so that the `font-sans`
    // utility and the body cannot drift onto different stacks.
    expect(s.bodyFontFamily).toContain("Inter");
    expect(s.fontSansUtility).toContain("Inter");
    expect(s.fontSansUtility).not.toContain("monospace");
  });

  it("renders the greet control as a styled shadcn Button", async () => {
    const s = await readComputed();

    // The starter shipped a raw <button>; the shadcn contract is data-slot.
    expect(s.button.exists).toBe(true);
    expect(s.button.variant).toBe("default");
    expect(s.button.size).toBe("default");
    expect(s.button.boxSizing).toBe("border-box");

    // `bg-primary` must resolve through cva + twMerge to the primary token,
    // not to the UA's default button face.
    expect(opaque(s.button.background!)).toBe(true);
    expect(same(s.button.background!, s.primaryToken)).toBe(true);
    expect(luminance(s.button.background!)).toBeLessThan(128);
    expect(luminance(s.button.color!)).toBeGreaterThan(128);
  });

  it("applies the shadcn size variants to the Button", async () => {
    const s = await readComputed();

    // h-9 = 2.25rem = 36px. A bare <button> lands near 21px, so this
    // distinguishes a resolved size variant from UA defaults.
    expect(s.button.exists).toBe(true);
    expect(parseFloat(s.button.height!)).toBeCloseTo(36, 0);
  });

  it("resolves Tailwind layout utilities on the logo row", async () => {
    const s = await readComputed();

    expect(s.logoRow.exists).toBe(true);
    expect(s.logoRow.display).toBe("flex");
  });

  after(async () => {
    const file = path.join(shotDir, "styling.png");
    const saved = await browser.saveScreenshot(file);
    expect(fs.existsSync(file)).toBe(true);
    expect(Buffer.isBuffer(saved)).toBe(true);
    console.log(`styling screenshot -> ${file} (${fs.statSync(file).size} bytes)`);
  });
});
