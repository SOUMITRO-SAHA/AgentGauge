import { expect, it } from "vitest";

import { renderHomebrewCask } from "~/lib/homebrew-cask";

it("renders a version-pinned Cask from the CDN DMG and checksum", () => {
  expect(
    renderHomebrewCask({
      version: "0.2.0",
      tag: "v0.2.0",
      sha256: "a".repeat(64),
    }),
  ).toBe(`cask "agentgauge" do
  version "0.2.0"
  sha256 "${"a".repeat(64)}"

  url "https://agentgauge.soumitrasaha.com/downloads/v0.2.0/AgentGauge-0.2.0-universal.dmg"
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
