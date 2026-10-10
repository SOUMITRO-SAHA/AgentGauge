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

export const desktopIconBackground = "#0F766E";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function composeDesktopIconSvg(sourceSvg: string) {
  if (!/<svg\b[^>]*>/i.test(sourceSvg)) {
    throw new Error("Desktop icons must be generated from an SVG source.");
  }

  return sourceSvg.replace(
    /<svg\b[^>]*>/i,
    (svgTag) =>
      `${svgTag}<style>.mark{fill:#F4F4F5!important}</style><rect width="100%" height="100%" fill="${desktopIconBackground}"/>`,
  );
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
