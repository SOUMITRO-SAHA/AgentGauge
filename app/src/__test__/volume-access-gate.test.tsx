/**
 * The volume-access gate must explain the macOS prompt before it appears and
 * stay honest while the grant is in flight: the primary action keeps the
 * dialog open (its `preventDefault` is what allows the pending state to
 * render at all), both buttons lock during the grant, and the dismiss path
 * remains reachable so "Not now" is a real choice, not a trap.
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { VolumeAccessDialog } from "~/components/permissions/volume-access-gate";

afterEach(() => {
  cleanup();
});

function renderDialog(
  overrides: Partial<{
    readonly granting: boolean;
    readonly onGrant: () => void;
    readonly onDismiss: () => void;
  }> = {},
) {
  const onGrant = vi.fn();
  const onDismiss = vi.fn();
  render(
    <VolumeAccessDialog
      granting={overrides.granting ?? false}
      onGrant={overrides.onGrant ?? onGrant}
      onDismiss={overrides.onDismiss ?? onDismiss}
    />,
  );
  return { onGrant: overrides.onGrant ?? onGrant, onDismiss: overrides.onDismiss ?? onDismiss };
}

it("explains the access, the macOS prompt, and that consent is remembered", () => {
  renderDialog();

  expect(
    screen.getByTestId("volume-access-dialog").textContent,
  ).toContain("removable volume");
  expect(screen.getByTestId("volume-access-dialog").textContent).toContain(
    "choose Allow",
  );
  expect(screen.getByTestId("volume-access-dialog").textContent).toContain(
    "only once",
  );
});

it("grants through the primary action without closing the dialog", async () => {
  const { onGrant } = renderDialog();

  await userEvent.click(screen.getByTestId("volume-access-grant"));

  expect(onGrant).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("volume-access-dialog")).toBeTruthy();
});

it("locks both actions and shows the pending label while granting", () => {
  renderDialog({ granting: true });

  expect(screen.getByTestId("volume-access-grant").textContent).toBe(
    "Allowing…",
  );
  expect(
    (screen.getByTestId("volume-access-grant") as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByTestId("volume-access-dismiss") as HTMLButtonElement).disabled,
  ).toBe(true);
});

it("dismisses through Not now", async () => {
  const { onDismiss } = renderDialog();

  await userEvent.click(screen.getByTestId("volume-access-dismiss"));

  expect(onDismiss).toHaveBeenCalledTimes(1);
});
