import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import * as Effect from "effect/Effect";

import { getUpdateChannel, upgradeHomebrew } from "~/lib/ipc";

export interface StagedUpdate {
  readonly version: string;
  readonly notes: string;
  readonly channel?: "direct" | "homebrew";
}

export interface UpdateCandidate {
  readonly version: string;
  readonly notes: string;
  readonly install: () => Promise<void>;
}

export interface AppUpdateClient {
  readonly check: () => Promise<UpdateCandidate | null>;
  readonly relaunch: () => Promise<void>;
  readonly channel?: () => Promise<"direct" | "homebrew">;
  readonly upgradeHomebrew?: (version: string) => Promise<void>;
}

export function createAppUpdateService(client: AppUpdateClient) {
  let stagedUpdate: StagedUpdate | null = null;
  let pendingHomebrew: StagedUpdate | null = null;

  return {
    async checkAndStage(): Promise<StagedUpdate | null> {
      pendingHomebrew = null;
      stagedUpdate = null;
      const channel = await (client.channel?.() ?? Promise.resolve("direct" as const));
      const candidate = await client.check();
      if (!candidate) return null;

      if (channel === "homebrew") {
        pendingHomebrew = {
          version: candidate.version,
          notes: candidate.notes,
          channel,
        };
        return pendingHomebrew;
      }

      await candidate.install();
      stagedUpdate = {
        version: candidate.version,
        notes: candidate.notes,
      };
      return stagedUpdate;
    },

    async installWithHomebrew(): Promise<void> {
      if (!pendingHomebrew || !client.upgradeHomebrew) {
        throw new Error("No Homebrew update is available.");
      }
      stagedUpdate = null;
      await client.upgradeHomebrew(pendingHomebrew.version);
      stagedUpdate = pendingHomebrew;
      pendingHomebrew = null;
    },

    async restart(): Promise<void> {
      if (!stagedUpdate) {
        throw new Error("No staged update is ready to restart.");
      }
      await client.relaunch();
    },
  };
}

interface UpdateTestFixture {
  available: boolean;
  version: string;
  notes: string;
  installComplete?: boolean;
  relaunchRequested?: boolean;
  channel?: "direct" | "homebrew";
  upgradeComplete?: boolean;
  upgradeFailure?: boolean;
}

declare global {
  interface Window {
    __agentgaugeUpdateFixture__?: UpdateTestFixture;
  }
}

function updateTestFixture(): UpdateTestFixture | undefined {
  if (import.meta.env.MODE !== "e2e" || typeof window === "undefined") {
    return undefined;
  }
  return window.__agentgaugeUpdateFixture__;
}

const nativeUpdateClient: AppUpdateClient = {
  async channel() {
    const fixture = updateTestFixture();
    if (fixture) return fixture.channel ?? "direct";
    if (!import.meta.env.PROD || !isMacOS()) return "direct";
    return Effect.runPromise(getUpdateChannel());
  },

  async upgradeHomebrew(version) {
    const fixture = updateTestFixture();
    if (fixture) {
      if (fixture.upgradeFailure) throw new Error("Homebrew could not upgrade AgentGauge.");
      fixture.upgradeComplete = true;
      return;
    }
    await Effect.runPromise(upgradeHomebrew(version));
  },

  async check() {
    const fixture = updateTestFixture();
    if (fixture) {
      if (!fixture.available) return null;
      return {
        version: fixture.version,
        notes: fixture.notes,
        install: async () => {
          fixture.installComplete = true;
        },
      };
    }

    if (!import.meta.env.PROD || !isMacOS()) return null;

    const update = await check();
    if (!update) return null;

    return {
      version: update.version,
      notes: update.body ?? "",
      install: () => update.downloadAndInstall(),
    };
  },

  async relaunch() {
    const fixture = updateTestFixture();
    if (fixture) {
      fixture.relaunchRequested = true;
      return;
    }
    await relaunch();
  },
};

export const appUpdateService = createAppUpdateService(nativeUpdateClient);

function isMacOS(): boolean {
  return typeof navigator !== "undefined" &&
    /Mac/i.test(`${navigator.platform} ${navigator.userAgent}`);
}
