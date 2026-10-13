import type { SystemWidgetStatus } from "~/lib/ipc";

/**
 * Whether the sidebar should push widget setup.
 *
 * The offer stands down only on positive confirmation that an AgentGauge widget
 * is on this Mac: WidgetCenter's own list for this app, plus the placement
 * receipts the widget extensions write, so a widget belonging to the sibling
 * build counts too. Every other state keeps the guide reachable — an unavailable
 * query (`configured: null`), a build with no embedded extension, or a first read
 * still in flight.
 *
 * Hiding the only route to the setup instructions precisely when detection is
 * broken is how a user ends up unable to add the widget at all, and the reverse
 * error — nagging a user whose widget is visibly on screen — is the one this
 * exists to prevent.
 */
export function shouldOfferWidgetSetup(status: SystemWidgetStatus): boolean {
  return status.supported && status.placedKinds.length === 0;
}
