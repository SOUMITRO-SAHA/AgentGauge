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

describe("desktop icon generation", () => {
  it("uses only the ink background and monochrome near-white mark", () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><style>.mark{fill:#17191d}</style><path class="mark" d="M1 2z"/><g class="mark"><path d="M1 2z"/></g></svg>';

    const composed = composeDesktopIconSvg(source);

    expect(desktopIconBackground).toBe("#111827");
    expect(desktopIconMarkColor).toBe("#F4F4F5");
    expect(composed).toContain(`<rect width="100%" height="100%" fill="${desktopIconBackground}"/>`);
    expect(composed).toContain(`.mark{fill:${desktopIconMarkColor}!important}`);
    expect(composed).toContain('<path class="mark" d="M1 2z"/>');
    expect(composed).toContain('<g class="mark">');
    expect(composed).not.toContain("#25C6B7");
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
