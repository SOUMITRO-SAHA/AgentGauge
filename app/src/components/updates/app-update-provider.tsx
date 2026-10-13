import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

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
import { appUpdateService } from "~/lib/app-update";
import type { StagedUpdate } from "~/lib/app-update";

type UpdateState =
  | { readonly kind: "idle" }
  | { readonly kind: "checking" }
  | { readonly kind: "up-to-date" }
  | { readonly kind: "failed" }
  | { readonly kind: "brew-available"; readonly update: StagedUpdate }
  | { readonly kind: "brew-upgrading"; readonly update: StagedUpdate }
  | { readonly kind: "brew-failed"; readonly update: StagedUpdate }
  | { readonly kind: "ready"; readonly update: StagedUpdate }
  | { readonly kind: "restarting"; readonly update: StagedUpdate }
  | { readonly kind: "restart-failed"; readonly update: StagedUpdate };

interface AppUpdateContextValue {
  readonly state: UpdateState;
  readonly checkForUpdates: () => void;
  readonly restart: () => void;
  readonly installWithHomebrew: () => void;
}

const EMPTY_CONTEXT: AppUpdateContextValue = {
  state: { kind: "idle" },
  checkForUpdates: () => undefined,
  restart: () => undefined,
  installWithHomebrew: () => undefined,
};

const AppUpdateContext = createContext<AppUpdateContextValue>(EMPTY_CONTEXT);

export function AppUpdateProvider({
  autoCheck,
  children,
}: {
  readonly autoCheck: boolean;
  readonly children: ReactNode;
}) {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const [promptOpen, setPromptOpen] = useState(false);
  const hasCheckedAutomatically = useRef(false);

  const runCheck = useCallback(async (showNoUpdate: boolean) => {
    setState({ kind: "checking" });
    try {
      const update = await appUpdateService.checkAndStage();
      if (!update) {
        setState(showNoUpdate ? { kind: "up-to-date" } : { kind: "idle" });
        return;
      }
      setState({ kind: update.channel === "homebrew" ? "brew-available" : "ready", update });
      setPromptOpen(true);
    } catch {
      setState(showNoUpdate ? { kind: "failed" } : { kind: "idle" });
    }
  }, []);

  const checkForUpdates = useCallback(() => {
    void runCheck(true);
  }, [runCheck]);

  const restart = useCallback(() => {
    if (state.kind !== "ready" && state.kind !== "restart-failed") return;
    const update = state.update;
    setState({ kind: "restarting", update });
    void appUpdateService.restart().catch(() => {
      setState({ kind: "restart-failed", update });
    });
  }, [state]);

  const installWithHomebrew = useCallback(() => {
    if (state.kind !== "brew-available" && state.kind !== "brew-failed") return;
    const update = state.update;
    setState({ kind: "brew-upgrading", update });
    void appUpdateService.installWithHomebrew().then(
      () => setState({ kind: "ready", update }),
      () => setState({ kind: "brew-failed", update }),
    );
  }, [state]);

  useEffect(() => {
    if (!autoCheck || hasCheckedAutomatically.current) return;
    hasCheckedAutomatically.current = true;
    void runCheck(false);
  }, [autoCheck, runCheck]);

  const update = state.kind === "brew-available" ||
    state.kind === "brew-upgrading" ||
    state.kind === "brew-failed" ||
    state.kind === "ready" ||
    state.kind === "restarting" ||
    state.kind === "restart-failed"
    ? state.update
    : null;

  return (
    <AppUpdateContext.Provider value={{ state, checkForUpdates, restart, installWithHomebrew }}>
      {children}
      {update && (
        <AlertDialog open={promptOpen} onOpenChange={setPromptOpen}>
          <AlertDialogContent data-testid="update-ready-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>AgentGauge update {update.channel === "homebrew" && state.kind !== "ready" ? "available" : "ready"}</AlertDialogTitle>
              <AlertDialogDescription>
                {update.channel === "homebrew" && state.kind !== "ready"
                  ? `Version ${update.version} is available. Homebrew manages this copy; choose Update with Homebrew to download and install it. The app will not run Brew until you choose that action.`
                  : `Version ${update.version} has been ${update.channel === "homebrew" ? "installed by Homebrew" : "downloaded and verified"}. Restart AgentGauge to finish installing it.`}
              </AlertDialogDescription>
              {state.kind === "brew-failed" && (
                <p className="text-sm text-destructive" data-testid="update-brew-failed">
                  Homebrew could not install the update. Check your tap and try again, or run the upgrade in Terminal.
                </p>
              )}
              {update.notes && (
                <p className="text-sm text-muted-foreground">{update.notes}</p>
              )}
              {state.kind === "restart-failed" && (
                <p
                  className="text-sm text-destructive"
                  data-testid="update-restart-failed"
                >
                  AgentGauge could not restart. Close and reopen the app to finish
                  the update.
                </p>
              )}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="update-later">
                Later
              </AlertDialogCancel>
              {update.channel === "homebrew" && state.kind !== "ready" && state.kind !== "restarting" && state.kind !== "restart-failed" ? (
                <AlertDialogAction
                  data-testid="update-brew-install"
                  disabled={state.kind === "brew-upgrading"}
                  onClick={(event) => { event.preventDefault(); installWithHomebrew(); }}
                >
                  {state.kind === "brew-upgrading" ? "Updating with Homebrew…" : "Update with Homebrew"}
                </AlertDialogAction>
              ) : (
                <AlertDialogAction
                  data-testid="update-restart"
                  disabled={state.kind === "restarting"}
                  onClick={(event) => { event.preventDefault(); restart(); }}
                >
                  {state.kind === "restarting" ? "Restarting…" : "Restart now"}
                </AlertDialogAction>
              )}
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </AppUpdateContext.Provider>
  );
}

export function useAppUpdate(): AppUpdateContextValue {
  return useContext(AppUpdateContext);
}
