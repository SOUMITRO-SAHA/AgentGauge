import { expect, it } from "vitest";

import {
  createMacInstallerManifest,
  createMacUpdaterManifest,
} from "~/lib/updater-manifest";

it("publishes one signed universal bundle for both macOS updater targets", () => {
  const manifest = createMacUpdaterManifest({
    version: "0.2.0",
    tag: "v0.2.0",
    signature: "signed-bundle",
    publishedAt: "2026-10-13T12:00:00.000Z",
  });

  expect(manifest).toEqual({
    version: "0.2.0",
    pub_date: "2026-10-13T12:00:00.000Z",
    platforms: {
      "darwin-aarch64": {
        signature: "signed-bundle",
        url: "https://github.com/SOUMITRO-SAHA/AgentGauge/releases/download/v0.2.0/AgentGauge.app.tar.gz",
      },
      "darwin-x86_64": {
        signature: "signed-bundle",
        url: "https://github.com/SOUMITRO-SAHA/AgentGauge/releases/download/v0.2.0/AgentGauge.app.tar.gz",
      },
    },
  });
});

it("publishes a versioned universal DMG for the website installer", () => {
  expect(
    createMacInstallerManifest({
      version: "0.2.0",
      tag: "v0.2.0",
      sha256: "a".repeat(64),
    }),
  ).toEqual({
    version: "0.2.0",
    url: "https://github.com/SOUMITRO-SAHA/AgentGauge/releases/download/v0.2.0/AgentGauge-0.2.0-universal.dmg",
    sha256: "a".repeat(64),
  });
});
