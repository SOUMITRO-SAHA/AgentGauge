import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertUpdaterRelease,
  assertUpdaterReleaseCommit,
} from "../src/lib/updater-release";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [tag, tagCommit, workflowCommit] = process.argv.slice(2);

if (!tag || !tagCommit || !workflowCommit) {
  throw new Error(
    "Usage: bun scripts/verify-updater-release.ts <vX.Y.Z> <tag-commit> <workflow-commit>",
  );
}

const config = JSON.parse(
  await readFile(resolve(appRoot, "src-tauri/tauri.conf.json"), "utf8"),
) as { readonly version: string };

assertUpdaterRelease(config.version, tag);
assertUpdaterReleaseCommit(tagCommit, workflowCommit);
