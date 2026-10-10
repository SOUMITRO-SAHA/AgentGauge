/// <reference types="node" />

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const desktopIconFiles = [
  "32x32.png",
  "64x64.png",
  "128x128.png",
  "128x128@2x.png",
  "icon.png",
  "icon.icns",
  "icon.ico",
  "StoreLogo.png",
  "Square30x30Logo.png",
  "Square44x44Logo.png",
  "Square71x71Logo.png",
  "Square89x89Logo.png",
  "Square107x107Logo.png",
  "Square142x142Logo.png",
  "Square150x150Logo.png",
  "Square284x284Logo.png",
  "Square310x310Logo.png",
] as const;

export const desktopIconBackground = "#111827";
export const desktopIconMarkColor = "#F4F4F5";

/**
 * Apple's macOS icon grid, measured from the icons macOS ships with rather than
 * assumed: every native app icon occupies the same 206 of every 256 pixels of
 * its canvas.
 */
export const MACOS_ICON_CANVAS = 1024;

/** Edge length of the opaque body within {@link MACOS_ICON_CANVAS}. */
export const MACOS_ICON_BODY = 824;

/** Corner radius of that body, matching the system icons at the same scale. */
export const MACOS_ICON_CORNER_RADIUS = 211;

/**
 * Superellipse exponent of the corner curve. `2` is a plain circular arc; the
 * system icons measure slightly fuller than that, which is the continuous
 * corner macOS uses rather than a circular one.
 */
export const MACOS_ICON_CORNER_EXPONENT = 2.4;

const MACOS_ICON_INSET = (MACOS_ICON_CANVAS - MACOS_ICON_BODY) / 2;

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function format(value: number): string {
  return String(Number(value.toFixed(6)));
}

function macosIconBodyPath(samplesPerCorner = 32): string {
  const radius = MACOS_ICON_CORNER_RADIUS;
  const quarter: Array<[number, number]> = [];
  for (let sample = 0; sample <= samplesPerCorner; sample++) {
    const t = (sample / samplesPerCorner) * (Math.PI / 2);
    quarter.push([
      radius * Math.cos(t) ** (2 / MACOS_ICON_CORNER_EXPONENT),
      radius * Math.sin(t) ** (2 / MACOS_ICON_CORNER_EXPONENT),
    ]);
  }

  const points: string[] = [];
  const arc = (x: number, y: number, signX: 1 | -1, signY: 1 | -1, reverse: boolean) => {
    for (const [dx, dy] of reverse ? [...quarter].reverse() : quarter) {
      points.push(`${format(x + signX * dx)} ${format(y + signY * dy)}`);
    }
  };

  arc(MACOS_ICON_INSET + MACOS_ICON_BODY - radius, MACOS_ICON_INSET + radius, 1, -1, true);
  arc(MACOS_ICON_INSET + MACOS_ICON_BODY - radius, MACOS_ICON_INSET + MACOS_ICON_BODY - radius, 1, 1, false);
  arc(MACOS_ICON_INSET + radius, MACOS_ICON_INSET + MACOS_ICON_BODY - radius, -1, 1, true);
  arc(MACOS_ICON_INSET + radius, MACOS_ICON_INSET + radius, -1, -1, false);

  return `M ${points.join(" L ")} Z`;
}

export function composeDesktopIconSvg(sourceSvg: string) {
  const openTag = sourceSvg.match(/<svg\b[^>]*>/i)?.[0];
  if (!openTag) {
    throw new Error("Desktop icons must be generated from an SVG source.");
  }
  const viewBox = openTag.match(/viewBox\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!viewBox) {
    throw new Error("Desktop icon sources must declare a viewBox.");
  }
  const [, , sourceWidth, sourceHeight] = viewBox.trim().split(/[\s,]+/).map(Number);

  const scale = MACOS_ICON_BODY / Math.max(sourceWidth, sourceHeight);
  const translateX = MACOS_ICON_INSET + (MACOS_ICON_BODY - sourceWidth * scale) / 2;
  const translateY = MACOS_ICON_INSET + (MACOS_ICON_BODY - sourceHeight * scale) / 2;

  const canvasViewBox = `viewBox="0 0 ${MACOS_ICON_CANVAS} ${MACOS_ICON_CANVAS}"`;
  const sizedTag = openTag
    .replace(/\s(?:width|height)\s*=\s*["'][^"']*["']/gi, "")
    .replace(/viewBox\s*=\s*["'][^"']*["']/i, canvasViewBox);

  const overlay =
    `<style>.mark{fill:${desktopIconMarkColor}!important}</style>` +
    `<path d="${macosIconBodyPath()}" fill="${desktopIconBackground}"/>` +
    `<g transform="translate(${format(translateX)} ${format(translateY)}) scale(${format(scale)})">`;

  return sourceSvg
    .replace(openTag, () => `${sizedTag}${overlay}`)
    .replace(/<\/svg\s*>/i, () => "</g></svg>");
}

export function copyDesktopIcons(generatedDirectory: string, destinationDirectory: string) {
  const missingFiles = desktopIconFiles.filter(
    (file) => !existsSync(path.join(generatedDirectory, file)),
  );
  if (missingFiles.length > 0) {
    throw new Error(`Tauri did not generate expected desktop icons: ${missingFiles.join(", ")}`);
  }

  mkdirSync(destinationDirectory, { recursive: true });
  for (const file of desktopIconFiles) {
    copyFileSync(path.join(generatedDirectory, file), path.join(destinationDirectory, file));
  }
}

function generateIcons(sourceArgument?: string, destinationArgument?: string) {
  const source = path.resolve(appRoot, sourceArgument ?? "public/logo.svg");
  const destination = path.resolve(
    appRoot,
    destinationArgument ?? "src-tauri/icons",
  );

  if (!existsSync(source)) {
    throw new Error(`Logo source does not exist: ${source}`);
  }

  const generatedDirectory = mkdtempSync(path.join(tmpdir(), "agentgauge-icons-"));
  try {
    const sourceSvg = readFileSync(source, "utf8");
    const iconSource = path.join(generatedDirectory, "desktop-icon.svg");
    writeFileSync(iconSource, composeDesktopIconSvg(sourceSvg));
    const result = spawnSync(
      process.execPath,
      ["run", "tauri", "icon", iconSource, "--output", generatedDirectory],
      { cwd: appRoot, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Tauri icon generation exited with status ${result.status ?? "unknown"}`);
    }

    copyDesktopIcons(generatedDirectory, destination);
    console.log(`Copied desktop icons from ${source} to ${destination}.`);
  } finally {
    rmSync(generatedDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, destination, ...extraArguments] = process.argv.slice(2);
  if (extraArguments.length > 0) {
    console.error("Usage: bun run icons:generate [source.svg] [destination-directory]");
    process.exitCode = 2;
  } else {
    try {
      generateIcons(source, destination);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
