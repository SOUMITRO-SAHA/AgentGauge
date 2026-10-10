/// <reference types="node" />

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  composeDesktopIconSvg,
  copyDesktopIcons,
  desktopIconBackground,
  desktopIconFiles,
  desktopIconMarkColor,
  MACOS_ICON_BODY,
  MACOS_ICON_CANVAS,
  MACOS_ICON_CORNER_EXPONENT,
  MACOS_ICON_CORNER_RADIUS,
} from "../../scripts/generate-icons";

const temporaryDirectories: string[] = [];

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "agentgauge-icons-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const sourceSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><style>.mark{fill:#17191d}</style><path class="mark" d="M1 2z"/><g class="mark"><path d="M1 2z"/></g></svg>';

function plateGeometry(composed: string) {
  const plate = composed.match(
    new RegExp(`<path d="([^"]+)" fill="${desktopIconBackground}"/>`),
  )?.[1];
  expect(plate, "the icon plate must be a path so it can carry a rounded shape").toBeDefined();
  const numbers = (plate ?? "").match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const xs = numbers.filter((_, index) => index % 2 === 0);
  const ys = numbers.filter((_, index) => index % 2 === 1);
  return {
    points: xs.length,
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

describe("desktop icon generation", () => {
  it("uses only the ink background and monochrome near-white mark", () => {
    const composed = composeDesktopIconSvg(sourceSvg);

    expect(desktopIconBackground).toBe("#111827");
    expect(desktopIconMarkColor).toBe("#F4F4F5");
    expect(composed).toContain(`.mark{fill:${desktopIconMarkColor}!important}`);
    expect(composed).toContain('<path class="mark" d="M1 2z"/>');
    expect(composed).toContain('<g class="mark">');
    expect(composed).not.toContain("#25C6B7");
  });

  it("draws the plate on Apple's macOS icon grid rather than edge to edge", () => {
    const composed = composeDesktopIconSvg(sourceSvg);
    const plate = plateGeometry(composed);
    const inset = (MACOS_ICON_CANVAS - MACOS_ICON_BODY) / 2;

    expect(composed).toContain(`viewBox="0 0 ${MACOS_ICON_CANVAS} ${MACOS_ICON_CANVAS}"`);
    expect(plate.minX).toBe(inset);
    expect(plate.minY).toBe(inset);
    expect(plate.maxX).toBe(MACOS_ICON_CANVAS - inset);
    expect(plate.maxY).toBe(MACOS_ICON_CANVAS - inset);
    expect(composed).not.toContain('width="100%"');
  });

  it("rounds the plate with a continuous corner rather than a square edge", () => {
    const plate = plateGeometry(composeDesktopIconSvg(sourceSvg));

    expect(MACOS_ICON_CORNER_RADIUS / MACOS_ICON_BODY).toBeCloseTo(0.256, 2);
    expect(MACOS_ICON_CORNER_EXPONENT).toBeGreaterThan(2);
    expect(MACOS_ICON_CORNER_EXPONENT).toBeLessThan(3);
    expect(plate.points).toBeGreaterThan(8);
  });

  it("scales the mark onto the plate so it cannot overflow the rounded body", () => {
    const composed = composeDesktopIconSvg(sourceSvg);
    const scale = MACOS_ICON_BODY / 512;
    const inset = (MACOS_ICON_CANVAS - MACOS_ICON_BODY) / 2;

    expect(composed).toContain(
      `<g transform="translate(${inset} ${inset}) scale(${scale})">`,
    );
    expect(composed).toContain("</g></svg>");
  });

  it("copies all desktop icon files and excludes mobile outputs", () => {
    const generated = temporaryDirectory();
    const destination = temporaryDirectory();
    for (const file of desktopIconFiles) {
      writeFileSync(path.join(generated, file), file);
    }
    mkdirSync(path.join(generated, "ios"));
    writeFileSync(path.join(generated, "ios", "AppIcon.png"), "mobile");
    mkdirSync(path.join(generated, "android"));
    writeFileSync(path.join(generated, "android", "ic_launcher.png"), "mobile");

    copyDesktopIcons(generated, destination);

    expect(desktopIconFiles.map((file) => readFileSync(path.join(destination, file), "utf8"))).toEqual(
      desktopIconFiles,
    );
    expect(existsSync(path.join(destination, "ios"))).toBe(false);
    expect(existsSync(path.join(destination, "android"))).toBe(false);
  });
});