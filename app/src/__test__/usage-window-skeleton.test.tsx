import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";

import { UsageWindowSkeleton } from "~/components/usage/usage-window-row";

afterEach(cleanup);

it("uses the shared shadcn skeleton primitive for each window placeholder", () => {
  render(createElement(UsageWindowSkeleton));

  const skeleton = screen.getByTestId("window-skeleton");
  expect(skeleton.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3);
});
