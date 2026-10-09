/**
 * Test setup.
 *
 * Stubs the Tauri bridge so component tests can render without a native shell.
 * Everything that needs the real thing is the e2e suite's job, not this one's.
 */

import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({ type: "protocol", version: 1 })),
}));

vi.stubGlobal(
  "matchMedia",
  vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
);