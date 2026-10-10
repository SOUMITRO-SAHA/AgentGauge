import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AutomationArt,
  RolloverArt,
  StatusArt,
  WelcomeArt,
  WidgetArt,
} from "~/components/onboarding/illustrations";

describe("onboarding artwork", () => {
  it.each([
    ["welcome", WelcomeArt, ["terminal", "code"]],
    ["status", StatusArt, ["verified", "freshness"]],
    ["rollover", RolloverArt, ["observed"]],
    ["widget", WidgetArt, ["widget"]],
    ["monitor", AutomationArt, ["watch", "no-send"]],
  ] as const)("illustrates %s with recognizable icons", (_, Art, icons) => {
    const markup = renderToStaticMarkup(<Art />);

    for (const icon of icons) {
      expect(markup).toContain(`data-art-icon="${icon}"`);
    }
    expect(markup).toContain('aria-hidden="true"');
  });
});
