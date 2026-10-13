const FEATURE_LOCKED_VERSION = "0.1.0";

export function assertUpdaterRelease(version: string, tag: string): void {
  if (version === FEATURE_LOCKED_VERSION) {
    throw new Error(`v${version} is locked and cannot be published`);
  }

  if (tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} must match app version v${version}`);
  }
}

export function assertUpdaterReleaseCommit(
  tagCommit: string,
  workflowCommit: string,
): void {
  if (tagCommit !== workflowCommit) {
    throw new Error("Release tag must point to the exact workflow commit.");
  }
}
