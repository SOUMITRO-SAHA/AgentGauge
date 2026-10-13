import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";

interface VolumeAccessDialogProps {
  readonly granting: boolean;
  readonly onGrant: () => void;
  readonly onDismiss: () => void;
}

/**
 * One-time gate for reading agent data that lives on a removable volume.
 *
 * macOS asks for removable-volume access through its own system prompt the
 * first time the app reads those files, and dev builds can forget the grant
 * between signatures. This dialog explains that system prompt before it
 * appears; the recorded consent is what keeps it from showing again.
 */
export function VolumeAccessDialog({
  granting,
  onGrant,
  onDismiss,
}: VolumeAccessDialogProps) {
  return (
    <AlertDialog open onOpenChange={(open) => {
      if (!open && !granting) {
        onDismiss();
      }
    }}>
      <AlertDialogContent data-testid="volume-access-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Read coding-agent data from a removable volume?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Some of your connected plans keep their usage logs and session data
            on an external volume. AgentGauge reads those files locally to show
            your quotas — nothing leaves this Mac. macOS will ask for
            permission the first time; choose Allow. Your answer is remembered,
            so this ask appears only once.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="volume-access-dismiss" disabled={granting}>
            Not now
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="volume-access-grant"
            disabled={granting}
            onClick={(event) => {
              event.preventDefault();
              onGrant();
            }}
          >
            {granting ? "Allowing…" : "Allow Access"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
