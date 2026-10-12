import type { SystemWidgetStatus } from "~/lib/ipc";

export function shouldOfferWidgetSetup(status: SystemWidgetStatus): boolean {
  return (
    status.supported &&
    status.extensionPresent &&
    status.configured === false
  );
}
