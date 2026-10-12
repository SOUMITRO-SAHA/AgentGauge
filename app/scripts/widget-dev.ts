import { watch, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const appBundle = resolve("src-tauri/target/debug/bundle/macos/AgentGauge Widget Dev.app");
const appIdentifier = "com.soumitrasaha.agentgauge.widgetdev";
const widgetBuildEnvironment = {
  ...process.env,
  AGENTGAUGE_WIDGET_CONFIGURATION: "Debug",
};

function run(command: string, args: string[], env = process.env) {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
}

function buildHost() {
  run("bunx", [
    "tauri",
    "build",
    "--debug",
    "--bundles",
    "app",
    "--config",
    "src-tauri/tauri.widget-dev.conf.json",
  ]);
}

function buildWidget() {
  run("./src-tauri/widget/build-widget.sh", ["build"], widgetBuildEnvironment);
  run("./src-tauri/widget/build-widget.sh", ["embed", appBundle], widgetBuildEnvironment);
}

function launchHost() {
  run("open", ["-n", appBundle]);
}

let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
let shouldRebuildHost = false;

function rebuildForWidgetChange(rebuildHost: boolean) {
  try {
    if (rebuildHost) {
      spawnSync("osascript", ["-e", `tell application id "${appIdentifier}" to quit`], {
        stdio: "ignore",
      });
      buildHost();
    }
    buildWidget();
    if (rebuildHost) launchHost();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
}

function scheduleRebuild(rebuildHost: boolean) {
  shouldRebuildHost ||= rebuildHost;
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    const rebuildHost = shouldRebuildHost;
    shouldRebuildHost = false;
    rebuildTimer = undefined;
    rebuildForWidgetChange(rebuildHost);
  }, 350);
}

buildHost();
buildWidget();
launchHost();

const watchers = [
  watch(resolve("src-tauri/widget/Sources"), { recursive: true }, () => scheduleRebuild(false)),
  watch(resolve("src-tauri/src/modules"), { recursive: true }, () => scheduleRebuild(true)),
  watch(resolve("src-tauri/src/shared"), { recursive: true }, () => scheduleRebuild(true)),
];

for (const watcher of watchers) watcher.on("error", (error) => console.error(error));
console.log("Watching widget Swift sources and snapshot producers. Place AgentGauge Dev from the macOS widget gallery once.");
