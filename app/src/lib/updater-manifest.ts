import { RELEASES_BASE_URL } from "~/lib/release-host";

interface MacUpdaterManifestInput {
  readonly version: string;
  readonly tag: string;
  readonly signature: string;
  readonly publishedAt: string;
}

interface MacUpdateArtifact {
  readonly signature: string;
  readonly url: string;
}

export interface MacUpdaterManifest {
  readonly version: string;
  readonly pub_date: string;
  readonly platforms: Readonly<Record<"darwin-aarch64" | "darwin-x86_64", MacUpdateArtifact>>;
}

export interface MacInstallerManifest {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
}

export function createMacUpdaterManifest({
  version,
  tag,
  signature,
  publishedAt,
}: MacUpdaterManifestInput): MacUpdaterManifest {
  const url = `${RELEASES_BASE_URL}/${encodeURIComponent(tag)}/AgentGauge.app.tar.gz`;
  const artifact = { signature, url };

  return {
    version,
    pub_date: publishedAt,
    platforms: {
      "darwin-aarch64": artifact,
      "darwin-x86_64": artifact,
    },
  };
}

export function createMacInstallerManifest({
  version,
  tag,
  sha256,
}: {
  readonly version: string;
  readonly tag: string;
  readonly sha256: string;
}): MacInstallerManifest {
  return {
    version,
    url: `${RELEASES_BASE_URL}/${encodeURIComponent(tag)}/AgentGauge-${version}-universal.dmg`,
    sha256,
  };
}
