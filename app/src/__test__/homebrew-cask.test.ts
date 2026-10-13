import { expect, it } from "vitest";

import { renderHomebrewCask } from "~/lib/homebrew-cask";

it("renders a version-pinned Cask from the GitHub release DMG and checksum", () => {
  expect(
    renderHomebrewCask({
      version: "0.2.0",
      sha256: "a".repeat(64),
    }),
  ).toBe(`cask "agentgauge" do
  version "0.2.0"
  sha256 "${"a".repeat(64)}"

  url "https://github.com/SOUMITRO-SAHA/AgentGauge/releases/download/v#{version}/AgentGauge-#{version}-universal.dmg"
  name "AgentGauge"
  desc "Usage monitor for AI coding harnesses"
  homepage "https://agentgauge.soumitrasaha.com"

  app "AgentGauge.app"

  caveats <<~EOS
    AgentGauge is ad-hoc signed and not notarized. macOS may block the first launch.
    Control-click AgentGauge.app, choose Open, and confirm to continue.
  EOS
end
`);
});
