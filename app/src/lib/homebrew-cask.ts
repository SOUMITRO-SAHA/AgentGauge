import { RELEASES_BASE_URL } from "~/lib/release-host";

export function renderHomebrewCask({
  version,
  sha256,
}: {
  readonly version: string;
  readonly sha256: string;
}): string {
  return `cask "agentgauge" do
  version "${version}"
  sha256 "${sha256}"

  url "${RELEASES_BASE_URL}/v#{version}/AgentGauge-#{version}-universal.dmg"
  name "AgentGauge"
  desc "Usage monitor for AI coding harnesses"
  homepage "https://agentgauge.soumitrasaha.com"

  app "AgentGauge.app"

  caveats <<~EOS
    AgentGauge is ad-hoc signed and not notarized. macOS may block the first launch.
    Control-click AgentGauge.app, choose Open, and confirm to continue.
  EOS
end
`;
}
