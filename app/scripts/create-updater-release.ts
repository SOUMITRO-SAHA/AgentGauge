import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createMacInstallerManifest,
  createMacUpdaterManifest,
} from "../src/lib/updater-manifest";
import { renderHomebrewCask } from "../src/lib/homebrew-cask";
import { assertUpdaterRelease } from "../src/lib/updater-release";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [appBundleArgument, tag] = process.argv.slice(2);
const appBundle = appBundleArgument ? resolve(appBundleArgument) : "";
const signingKeyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH;
const appName = "AgentGauge.app";

if (!appBundle || !tag || basename(appBundle) !== appName) {
  throw new Error(
    "Usage: bun scripts/create-updater-release.ts <AgentGauge.app> <vX.Y.Z>",
  );
}

const config = JSON.parse(
  await readFile(resolve(appRoot, "src-tauri/tauri.conf.json"), "utf8"),
) as { readonly version: string };

assertUpdaterRelease(config.version, tag);

if (!signingKeyPath || !existsSync(signingKeyPath)) {
  throw new Error("TAURI_SIGNING_PRIVATE_KEY_PATH must point to the updater key.");
}

const extension = resolve(appBundle, "Contents/PlugIns/AIStatsWidget.appex");
const bridge = resolve(appBundle, "Contents/Frameworks/libWidgetBridge.dylib");
if (!existsSync(extension) || !existsSync(bridge)) {
  throw new Error("The final app bundle must contain its WidgetKit extension and bridge.");
}

const artifactDirectory = dirname(appBundle);
const artifactPath = resolve(artifactDirectory, "AgentGauge.app.tar.gz");
const signaturePath = `${artifactPath}.sig`;
const manifestPath = resolve(artifactDirectory, "latest.json");
const checksumPath = `${artifactPath}.sha256`;
const dmgPath = resolve(
  artifactDirectory,
  `AgentGauge-${config.version}-universal.dmg`,
);
const dmgChecksumPath = `${dmgPath}.sha256`;
const installerManifestPath = resolve(artifactDirectory, "latest-macos.json");
const caskPath = resolve(artifactDirectory, "agentgauge.rb");

if (!existsSync(dmgPath)) {
  throw new Error(`The distribution DMG is missing: ${dmgPath}`);
}

await run("tar", ["-czf", artifactPath, "-C", artifactDirectory, appName]);
await run(
  "bun",
  [
    "run",
    "tauri",
    "signer",
    "sign",
    "--app-version",
    config.version,
    "--private-key-path",
    signingKeyPath,
    artifactPath,
  ],
  appRoot,
);

const signature = (await readFile(signaturePath, "utf8")).trim();
const manifest = createMacUpdaterManifest({
  version: config.version,
  tag,
  signature,
  publishedAt: new Date().toISOString(),
});
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const checksum = createHash("sha256")
  .update(await readFile(artifactPath))
  .digest("hex");
await writeFile(checksumPath, `${checksum}  ${basename(artifactPath)}\n`);

const dmgChecksum = createHash("sha256")
  .update(await readFile(dmgPath))
  .digest("hex");
await writeFile(
  dmgChecksumPath,
  `${dmgChecksum}  ${basename(dmgPath)}\n`,
);
const installerManifest = createMacInstallerManifest({
  version: config.version,
  tag,
  sha256: dmgChecksum,
});
await writeFile(
  installerManifestPath,
  `${JSON.stringify(installerManifest, null, 2)}\n`,
);
await writeFile(
  caskPath,
  renderHomebrewCask({
    version: config.version,
    tag,
    sha256: dmgChecksum,
  }),
);

async function run(
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<void> {
  const process = Bun.spawn([command, ...args], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`${command} exited with status ${exitCode}.`);
  }
}
