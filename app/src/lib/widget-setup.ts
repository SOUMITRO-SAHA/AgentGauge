import type { SystemWidgetStatus } from "~/lib/ipc";

/**
 * Whether the sidebar should push widget setup.
 *
 * The offer stands down only on positive confirmation: a system query that
 * listed an AgentGauge widget. Every other state keeps the guide reachable —
 * an unavailable query (`configured: null`), a build with no embedded
 * extension, or a first read still in flight.
 *
 * Hiding the only route to the setup instructions precisely when detection is
 * broken is how a user ends up unable to add the widget at all. Offering the
 * guide claims nothing: the panel it opens names the real state, including
 * "could not check".
 */
export function shouldOfferWidgetSetup(status: SystemWidgetStatus): boolean {
  return (
    status.supported &&
    status.configured !== true &&
    status.configuredKinds.length === 0
  );
}