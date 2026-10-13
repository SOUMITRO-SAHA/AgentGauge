import { HardDrives } from "@phosphor-icons/react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";

export function VolumeAccessDialog({
  granting,
  onGrant,
  onDismiss,
}: {
  readonly granting: boolean;
  readonly onGrant: () => void;
  readonly onDismiss: () => void;
}) {
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onDismiss(); }}>
      <AlertDialogContent data-testid="volume-access-dialog">
        <AlertDialogHeader>
          <AlertDialogMedia>
            <HardDrives weight="duotone" className="size-8 text-muted-foreground" />
          </AlertDialogMedia>
          <AlertDialogTitle>External volume access</AlertDialogTitle>
          <AlertDialogDescription>
            AgentGauge reads token-usage logs and session data from
            coding agents stored on an external drive. Allow access
            once so the stats page can load your data.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            data-testid="volume-access-skip"
            onClick={onDismiss}
          >
            Not now
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="volume-access-allow"
            disabled={granting}
            onClick={(event) => { event.preventDefault(); onGrant(); }}
          >
            {granting ? "Allowing…" : "Allow access"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
