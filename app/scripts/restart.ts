import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

type ProcessInfo = {
  pid: number;
  ppid: number;
  command: string;
};

const appRoot = path.resolve(import.meta.dir, "..");
const normalizedAppRoot = normalizePath(appRoot);

function normalizePath(value: string) {
  return value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function listProcesses(): ProcessInfo[] {
  if (process.platform === "win32") {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(output || "[]") as
      | { ProcessId: number; ParentProcessId: number; CommandLine: string }[]
      | { ProcessId: number; ParentProcessId: number; CommandLine: string };
    const processes = Array.isArray(parsed) ? parsed : [parsed];

    return processes.map((entry) => ({
      pid: Number(entry.ProcessId),
      ppid: Number(entry.ParentProcessId),
      command: entry.CommandLine ?? "",
    }));
  }

  const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
  });

  return output
    .split("\n")
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return match
        ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }]
        : [];
    });
}

function currentProcessAndAncestors(processes: ProcessInfo[]) {
  const parents = new Map(processes.map((entry) => [entry.pid, entry.ppid]));
  const excluded = new Set<number>();
  let pid = process.pid;

  while (pid > 0 && !excluded.has(pid)) {
    excluded.add(pid);
    pid = parents.get(pid) ?? 0;
  }

  return excluded;
}

function appProcessTree(processes: ProcessInfo[]) {
  const excluded = currentProcessAndAncestors(processes);
  const selected = new Set(
    processes
      .filter(
        (entry) =>
          !excluded.has(entry.pid) &&
          normalizePath(entry.command).includes(normalizedAppRoot),
      )
      .map((entry) => entry.pid),
  );

  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of processes) {
      if (
        !excluded.has(entry.pid) &&
        !selected.has(entry.pid) &&
        selected.has(entry.ppid)
      ) {
        selected.add(entry.pid);
        changed = true;
      }
    }
  }

  return selected;
}

async function stopProcesses(processes: ProcessInfo[], pids: Set<number>) {
  if (pids.size === 0) {
    console.log("No existing app processes found.");
    return;
  }

  const parents = new Map(processes.map((entry) => [entry.pid, entry.ppid]));
  const depth = (pid: number) => {
    let value = 0;
    while (parents.has(pid)) {
      value += 1;
      pid = parents.get(pid)!;
    }
    return value;
  };
  const orderedPids = [...pids].sort((a, b) => depth(b) - depth(a));

  if (process.platform === "win32") {
    const roots = orderedPids.filter((pid) => !pids.has(parents.get(pid) ?? -1));
    for (const pid of roots) {
      try {
        execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } catch {
        // It may have exited while the process tree was being inspected.
      }
    }
  } else {
    for (const pid of orderedPids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // It may have exited while the process tree was being inspected.
      }
    }

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const remaining = new Set(
        listProcesses()
          .filter((entry) => pids.has(entry.pid))
          .map((entry) => entry.pid),
      );
      if (remaining.size === 0) break;
      await Bun.sleep(100);
    }

    for (const pid of pids) {
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        // It exited during the final check.
      }
    }
  }

  console.log(`Stopped ${pids.size} process(es) belonging to this app.`);
}

async function ensurePortsAreAvailable(ports: number[]) {
  for (const port of ports) {
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once("error", () => {
        reject(
          new Error(
            `Port ${port} is still in use by a process not identified as part of this app. Stop that process and retry.`,
          ),
        );
      });
      server.listen(port, "127.0.0.1", () => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    });
  }
}

const processes = listProcesses();
await stopProcesses(processes, appProcessTree(processes));
await ensurePortsAreAvailable([1420, 1421]);

console.log("Starting the native app…");
const child = Bun.spawn(["bun", "run", "start"], {
  cwd: appRoot,
  env: process.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exitCode = await child.exited;
