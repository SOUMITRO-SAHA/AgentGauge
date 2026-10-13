import { expect, it } from "vitest";

import {
  assertUpdaterRelease,
  assertUpdaterReleaseCommit,
} from "~/lib/updater-release";

it("rejects the feature-locked v0.1.0 release", () => {
  expect(() => assertUpdaterRelease("0.1.0", "v0.1.0")).toThrow(
    "v0.1.0 is locked and cannot be published",
  );
});

it("accepts a matching next-version release tag", () => {
  expect(() => assertUpdaterRelease("0.2.0", "v0.2.0")).not.toThrow();
});

it("rejects release tags that do not match the app version", () => {
  expect(() => assertUpdaterRelease("0.2.0", "v0.3.0")).toThrow(
    "Release tag v0.3.0 must match app version v0.2.0",
  );
});

it("rejects a release tag that does not point at the workflow commit", () => {
  expect(() => assertUpdaterReleaseCommit("tag-commit", "main-commit")).toThrow(
    "Release tag must point to the exact workflow commit",
  );
});

it("accepts a release tag that points at the workflow commit", () => {
  expect(() => assertUpdaterReleaseCommit("same-commit", "same-commit")).not.toThrow();
});
