import { expect, it } from "bun:test";

import { DOWNLOADS_BASE_URL, downloadsAreAvailable } from "./downloads";

it("uses the website downloads path", () => {
  expect(DOWNLOADS_BASE_URL).toBe(
    "https://agentgauge.soumitrasaha.com/downloads",
  );
});

it("keeps release links hidden until published artifacts are available", () => {
  expect(downloadsAreAvailable(undefined)).toBe(false);
  expect(downloadsAreAvailable("false")).toBe(false);
  expect(downloadsAreAvailable("true")).toBe(true);
});
