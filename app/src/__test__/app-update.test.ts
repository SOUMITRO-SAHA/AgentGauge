import { expect, it, vi } from "vitest";

import { createAppUpdateService } from "~/lib/app-update";

it("stages and verifies an update before reporting it as ready", async () => {
  let installed = false;
  const candidate = {
    version: "0.2.0",
    notes: "Maintenance release",
    install: vi.fn(async () => {
      installed = true;
    }),
  };
  const service = createAppUpdateService({
    check: vi.fn().mockResolvedValue(candidate),
    relaunch: vi.fn().mockResolvedValue(undefined),
  });

  await expect(service.checkAndStage()).resolves.toEqual({
    version: "0.2.0",
    notes: "Maintenance release",
  });
  expect(candidate.install).toHaveBeenCalledOnce();
  expect(installed).toBe(true);
});

it("does not restart until an update has been staged", async () => {
  const relaunch = vi.fn().mockResolvedValue(undefined);
  const service = createAppUpdateService({
    check: vi.fn().mockResolvedValue(null),
    relaunch,
  });

  await expect(service.restart()).rejects.toThrow("No staged update is ready");
  expect(relaunch).not.toHaveBeenCalled();
});

it("relaunches only after a staged update is confirmed", async () => {
  const relaunch = vi.fn().mockResolvedValue(undefined);
  const service = createAppUpdateService({
    check: vi.fn().mockResolvedValue({
      version: "0.2.0",
      notes: "Maintenance release",
      install: vi.fn().mockResolvedValue(undefined),
    }),
    relaunch,
  });

  await service.checkAndStage();
  await service.restart();

  expect(relaunch).toHaveBeenCalledOnce();
});

it("offers a Homebrew update without installing Tauri's archive", async () => {
  const install = vi.fn();
  const upgradeHomebrew = vi.fn().mockResolvedValue(undefined);
  const service = createAppUpdateService({
    check: vi.fn().mockResolvedValue({ version: "0.2.0", notes: "New", install }),
    relaunch: vi.fn(),
    channel: vi.fn().mockResolvedValue("homebrew"),
    upgradeHomebrew,
  });

  expect(await service.checkAndStage()).toEqual({
    version: "0.2.0", notes: "New", channel: "homebrew",
  });
  expect(install).not.toHaveBeenCalled();
  await expect(service.restart()).rejects.toThrow("No staged update");
  await service.installWithHomebrew();
  expect(upgradeHomebrew).toHaveBeenCalledWith("0.2.0");
  expect(install).not.toHaveBeenCalled();
  await expect(service.restart()).resolves.toBeUndefined();
});

it("does not allow a restart when Homebrew failed", async () => {
  const service = createAppUpdateService({
    check: vi.fn().mockResolvedValue({ version: "0.2.0", notes: "", install: vi.fn() }),
    relaunch: vi.fn(),
    channel: vi.fn().mockResolvedValue("homebrew"),
    upgradeHomebrew: vi.fn().mockRejectedValue(new Error("Brew failed")),
  });

  await service.checkAndStage();
  await expect(service.installWithHomebrew()).rejects.toThrow("Brew failed");
  await expect(service.restart()).rejects.toThrow("No staged update");
});
