//! Read-only process and storage insights for the agent toolchain.
//!
//! One bounded capability: a snapshot of what Codex and OpenCode are doing
//! to this machine — running processes with their memory, age, and listening
//! ports, and the on-disk footprint each one owns. The app itself is
//! deliberately not a group: the screen is for the toolchain's cost, not
//! ours. Everything here is a read; there is deliberately no capability to
//! stop, signal, or delete anything.
//!
//! [`RawProcess`] is the provider-agnostic process record. The matching and
//! grouping functions over it are pure and unit-tested; the `sysinfo` adapter
//! is a thin translation at the edge so the logic can be exercised without a
//! live process table. Storage is measured with a plain filesystem walk —
//! logical file sizes, symlinks not followed — and an unreadable subtree
//! contributes nothing rather than failing the whole read.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One running process, as the renderer renders it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSummary {
    pub pid: u32,
    pub name: String,
    /// The command line, joined and length-capped. `None` when the platform
    /// withholds it (Windows without elevation reports an empty command).
    pub command: Option<String>,
    /// Unix **seconds**; uptime is derived against the clock at render time
    /// so it ticks without another read.
    pub started_at: Option<u64>,
    /// Resident set size in bytes.
    pub memory_bytes: Option<u64>,
    /// The TCP ports this process is listening on, sorted. Empty is a real
    /// answer — a stdio server listens on nothing.
    pub listening_ports: Vec<u16>,
}

/// One process's listening TCP socket, as reported by the platform scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessPort {
    pub pid: u32,
    pub port: u16,
}

/// The group-level answer to "which ports are these processes listening on?".
///
/// `Checked` with an empty list is a real answer, not a gap: a stdio server
/// (`codex app-server`) listens on nothing, and the screen must say so
/// rather than imply a reading is missing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PortScan {
    Checked { listening: Vec<ProcessPort> },
    Unavailable { reason: String },
}

/// One labelled piece of a storage footprint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageRow {
    pub label: String,
    pub path: String,
    pub bytes: u64,
    pub file_count: u64,
}

/// A group's storage footprint, or the honest reason there is none.
///
/// The two states are distinct answers: a tool that has never created its
/// data directory is "absent", which must never render as `0 B` — that would
/// read as measured emptiness.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StorageReport {
    Measured {
        total_bytes: u64,
        total_files: u64,
        rows: Vec<StorageRow>,
    },
    Absent {
        reason: String,
    },
}

/// Everything the screen shows about one group of processes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessGroup {
    pub id: String,
    pub display_name: String,
    pub processes: Vec<ProcessSummary>,
    pub total_memory_bytes: u64,
    pub storage: StorageReport,
    /// Whether and where this group's processes are listening on TCP.
    pub ports: PortScan,
}

/// The whole read: one row per group, in the order the screen shows them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInsights {
    /// Epoch milliseconds.
    pub fetched_at: u64,
    pub groups: Vec<ProcessGroup>,
}

/// The provider-agnostic process record the pure logic works on.
///
/// Built from `sysinfo` at the edge; tests construct them directly so the
/// matching rules are exercised without a live process table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawProcess {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    /// The executable path, when the platform reports one.
    pub exe: Option<String>,
    /// The process name as the platform reports it (may be truncated).
    pub name: String,
    /// The command line, argument by argument.
    pub cmd: Vec<String>,
    pub memory_bytes: u64,
    /// Epoch seconds.
    pub started_at: u64,
}

/// The roots each group's storage is measured from.
///
/// Resolved by the caller so tests inject temporary directories; `None`
/// means the root cannot be known (no home directory), which renders as an
/// absent footprint with a reason.
#[derive(Debug, Clone, Default)]
pub struct PathEnv {
    pub codex_home: Option<PathBuf>,
    pub opencode_data: Option<PathBuf>,
}

/// The executables tracked as tool groups.
const TRACKED_TOOLS: [(&str, &str); 2] = [("codex", "Codex"), ("opencode", "OpenCode")];

/// Longest command line returned, in characters.
const MAX_COMMAND_CHARS: usize = 160;

/// Normalizes a path or process name to a comparable executable stem:
/// lowercase, without directories, without a Windows `.exe` suffix.
fn normalized_stem(value: &str) -> String {
    let base = value.rsplit(['/', '\\']).next().unwrap_or(value);
    base.strip_suffix(".exe").unwrap_or(base).to_lowercase()
}

/// Whether a process belongs to the given executable's group.
///
/// Matches the executable path or the process name directly. Command
/// arguments count only when the process was launched by a known runtime
/// (`npx codex`, `bun opencode`) — the runtime is the executable and the
/// tool rides in its arguments. For anything else an argument is just a
/// mention: `rg codex src/` takes the name as a bare argument and must not
/// land in Codex's panel.
fn matches_tool(process: &RawProcess, executable: &str) -> bool {
    if process
        .exe
        .as_deref()
        .is_some_and(|exe| normalized_stem(exe) == executable)
    {
        return true;
    }
    if normalized_stem(&process.name) == executable {
        return true;
    }
    launched_by_runtime(process)
        && process
            .cmd
            .iter()
            .any(|arg| normalized_stem(arg) == executable)
}

/// Launchers whose arguments may name the real tool being run.
///
/// Windows npm shims appear as `.cmd`, which [`normalized_stem`] does not
/// strip, so they are listed explicitly. `cmd` is deliberately absent: its
/// arguments are as often mentions as tool names, and Windows is not an
/// exercised platform yet.
const RUNTIME_LAUNCHERS: &[&str] = &[
    "node", "bun", "bunx", "npx", "npm", "pnpm", "yarn", "deno", "sh", "bash", "zsh", "env",
    "npx.cmd", "npm.cmd",
];

/// Whether the process was launched by a runtime that execs the real tool
/// from its own arguments.
fn launched_by_runtime(process: &RawProcess) -> bool {
    process
        .cmd
        .first()
        .is_some_and(|first| RUNTIME_LAUNCHERS.contains(&normalized_stem(first).as_str()))
}

/// Selects one tracked tool's processes.
pub fn select_tool(processes: &[RawProcess], executable: &str) -> Vec<RawProcess> {
    processes
        .iter()
        .filter(|process| matches_tool(process, executable))
        .cloned()
        .collect()
}

/// A completed storage walk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct Walked {
    bytes: u64,
    file_count: u64,
}

/// Sums logical file sizes under a root.
///
/// Symlinks are never followed (a link cannot multiply the same bytes into
/// two tools' footprints) and a path that cannot be read contributes nothing
/// instead of failing the read. Only a root that cannot be entered at all is
/// an error.
fn walk_size(root: &Path) -> std::io::Result<Walked> {
    let mut stack = vec![root.to_path_buf()];
    let mut walked = Walked::default();

    while let Some(current) = stack.pop() {
        let entries = match std::fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(error) => {
                if current == root {
                    return Err(error);
                }
                continue;
            }
        };

        for entry in entries.flatten() {
            let Ok(metadata) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                stack.push(entry.path());
            } else {
                walked.bytes += metadata.len();
                walked.file_count += 1;
            }
        }
    }

    Ok(walked)
}

/// One labelled piece of a footprint.
enum Component {
    /// A subdirectory of the root, walked whole.
    Directory {
        label: &'static str,
        name: &'static str,
    },
    /// The root's SQLite database files — `*.sqlite` / `*.db` plus their
    /// `-wal` and `-shm` siblings — summed into one row whose path names
    /// every file counted.
    SqliteFiles { label: &'static str },
}

/// Whether a root-level file is part of a SQLite database.
///
/// The `-wal` and `-shm` siblings are part of the database's footprint and
/// can dwarf the main file between checkpoints. A lookalike suffix
/// (`foo.sqlitebackup`) is not a database file.
fn is_database_file(name: &str) -> bool {
    name.ends_with(".sqlite")
        || name.ends_with(".db")
        || name.contains(".sqlite-")
        || name.contains(".db-")
}

/// Sums the root's database files, returning the walk and the matched names.
fn walk_sqlite_files(root: &Path) -> Option<(Walked, Vec<String>)> {
    let entries = std::fs::read_dir(root).ok()?;
    let mut walked = Walked::default();
    let mut names = Vec::new();

    for entry in entries.flatten() {
        let Ok(metadata) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_database_file(&name) {
            continue;
        }
        walked.bytes += metadata.len();
        walked.file_count += 1;
        names.push(name);
    }

    if names.is_empty() {
        None
    } else {
        names.sort_unstable();
        Some((walked, names))
    }
}

/// Measures a footprint from a root and labelled components inside it.
///
/// `total` always describes the whole root; each component that exists
/// becomes a row, and one arithmetic "everything else" row closes the gap so
/// the rows always sum to the total.
fn measure_storage(root: &Path, components: &[Component]) -> StorageReport {
    let Ok(total) = walk_size(root) else {
        return StorageReport::Absent {
            reason: format!("`{}` does not exist or cannot be read.", root.display()),
        };
    };

    let mut rows = Vec::new();
    let mut component_bytes = 0;
    let mut component_files = 0;
    for component in components {
        match component {
            Component::Directory { label, name } => {
                let path = root.join(name);
                if let Ok(walked) = walk_size(&path) {
                    component_bytes += walked.bytes;
                    component_files += walked.file_count;
                    rows.push(StorageRow {
                        label: (*label).to_owned(),
                        path: path.display().to_string(),
                        bytes: walked.bytes,
                        file_count: walked.file_count,
                    });
                }
            }
            Component::SqliteFiles { label } => {
                if let Some((walked, names)) = walk_sqlite_files(root) {
                    component_bytes += walked.bytes;
                    component_files += walked.file_count;
                    rows.push(StorageRow {
                        label: (*label).to_owned(),
                        path: names.join(", "),
                        bytes: walked.bytes,
                        file_count: walked.file_count,
                    });
                }
            }
        }
    }

    rows.push(StorageRow {
        label: "Everything else".to_owned(),
        path: root.display().to_string(),
        bytes: total.bytes.saturating_sub(component_bytes),
        file_count: total.file_count.saturating_sub(component_files),
    });

    StorageReport::Measured {
        total_bytes: total.bytes,
        total_files: total.file_count,
        rows,
    }
}

/// One tracked tool's footprint, from its resolved data root.
///
/// An executable with no defined root reports exactly that. It must never
/// fall through to another tool's directories: a future tracked tool that
/// reaches here without storage support would otherwise display OpenCode's
/// footprint under its own name, and nothing would look wrong.
fn tool_storage(executable: &str, paths: &PathEnv) -> StorageReport {
    let (display_name, root, components) = match executable {
        "codex" => (
            "Codex",
            paths.codex_home.as_deref(),
            [
                Component::Directory {
                    label: "Session transcripts",
                    name: "sessions",
                },
                Component::Directory {
                    label: "Archived transcripts",
                    name: "archived_sessions",
                },
                Component::SqliteFiles {
                    label: "Databases (SQLite)",
                },
            ]
            .as_slice(),
        ),
        "opencode" => (
            "OpenCode",
            paths.opencode_data.as_deref(),
            [
                Component::Directory {
                    label: "Session storage",
                    name: "storage",
                },
                Component::Directory {
                    label: "Logs",
                    name: "log",
                },
                Component::SqliteFiles {
                    label: "Databases (SQLite)",
                },
            ]
            .as_slice(),
        ),
        other => {
            return StorageReport::Absent {
                reason: format!("No data directory is defined for `{other}` in this build."),
            };
        }
    };

    let Some(root) = root else {
        return StorageReport::Absent {
            reason: "No home directory is available, so the data directory cannot be located."
                .to_owned(),
        };
    };
    if !root.exists() {
        return StorageReport::Absent {
            reason: format!("{display_name} has not created `{}` yet.", root.display()),
        };
    }
    measure_storage(root, components)
}

/// Parses `lsof -F pcn` output into pid/port pairs.
///
/// A `p` line starts a process record; the `n` lines that follow are its
/// nodes, and only nodes ending in a parseable port count (`*` and other
/// portless forms are skipped). Unparseable pids are skipped rather than
/// guessed.
fn parse_lsof_ports(raw: &str) -> Vec<ProcessPort> {
    let mut ports = Vec::new();
    let mut current_pid: Option<u32> = None;

    for line in raw.lines() {
        if let Some(pid) = line.strip_prefix('p') {
            current_pid = pid.parse().ok();
        } else if let Some(node) = line.strip_prefix('n') {
            let Some(pid) = current_pid else {
                continue;
            };
            let Some(port) = node.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) else {
                continue;
            };
            ports.push(ProcessPort { pid, port });
        }
    }

    ports
}

/// Asks the platform which of these processes are listening on TCP.
///
/// One `lsof` invocation covers every pid. An empty answer is a real
/// checked result — nothing is listening — so only a failure to run the
/// tool at all is [`PortScan::Unavailable`], which is what Windows and
/// lsof-less systems receive.
fn scan_ports(pids: &[u32]) -> PortScan {
    if pids.is_empty() {
        return PortScan::Checked {
            listening: Vec::new(),
        };
    }

    let mut command = std::process::Command::new("lsof");
    command.args(["-a", "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"]);
    for pid in pids {
        command.arg("-p").arg(pid.to_string());
    }

    match command.output() {
        Ok(output) => PortScan::Checked {
            listening: parse_lsof_ports(&String::from_utf8_lossy(&output.stdout)),
        },
        Err(error) => PortScan::Unavailable {
            reason: format!("Listening ports could not be inspected: {error}."),
        },
    }
}

/// The sorted, deduplicated ports one process is listening on.
fn ports_for_pid(ports: &PortScan, pid: u32) -> Vec<u16> {
    let PortScan::Checked { listening } = ports else {
        return Vec::new();
    };
    let mut own: Vec<u16> = listening
        .iter()
        .filter(|entry| entry.pid == pid)
        .map(|entry| entry.port)
        .collect();
    own.sort_unstable();
    own.dedup();
    own
}

/// Narrows a whole-read scan to one group's processes.
fn group_ports(ports: &PortScan, group: &[RawProcess]) -> PortScan {
    match ports {
        PortScan::Checked { listening } => PortScan::Checked {
            listening: listening
                .iter()
                .filter(|entry| group.iter().any(|process| process.pid == entry.pid))
                .cloned()
                .collect(),
        },
        PortScan::Unavailable { reason } => PortScan::Unavailable {
            reason: reason.clone(),
        },
    }
}

/// Builds the whole read from a process snapshot and resolved roots.
///
/// The port scan is passed in rather than run here so the report assembly
/// stays pure: tests inject a scan, production injects [`scan_ports`]'s
/// answer for exactly the pids the groups selected. Only the tracked tools
/// have groups — the app's own processes belong to none of them, so this
/// process, any other `agentgauge` binary, and the widget extension simply
/// do not appear.
pub fn build_report(
    processes: &[RawProcess],
    paths: &PathEnv,
    ports: PortScan,
    now_ms: u64,
) -> ProcessInsights {
    let mut groups = Vec::with_capacity(TRACKED_TOOLS.len());

    for (executable, display_name) in TRACKED_TOOLS {
        let mut selected = select_tool(processes, executable);
        selected.sort_by_key(|process| process.started_at);
        groups.push(ProcessGroup {
            id: executable.to_owned(),
            display_name: display_name.to_owned(),
            total_memory_bytes: selected.iter().map(|process| process.memory_bytes).sum(),
            processes: selected
                .iter()
                .map(|process| summarize(process, &ports_for_pid(&ports, process.pid)))
                .collect(),
            storage: tool_storage(executable, paths),
            ports: group_ports(&ports, &selected),
        });
    }

    ProcessInsights {
        fetched_at: now_ms,
        groups,
    }
}

/// One process summarized for the wire.
fn summarize(process: &RawProcess, listening_ports: &[u16]) -> ProcessSummary {
    ProcessSummary {
        pid: process.pid,
        name: process.name.clone(),
        command: display_command(&process.cmd),
        started_at: Some(process.started_at),
        memory_bytes: Some(process.memory_bytes),
        listening_ports: listening_ports.to_vec(),
    }
}

/// The command line joined and capped, or `None` when nothing was reported.
fn display_command(cmd: &[String]) -> Option<String> {
    if cmd.is_empty() {
        return None;
    }
    Some(cmd.join(" ").chars().take(MAX_COMMAND_CHARS).collect())
}

/// Reads a live snapshot of every process the platform reports.
fn snapshot_processes() -> Vec<RawProcess> {
    use sysinfo::{ProcessesToUpdate, System};

    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);

    system
        .processes()
        .iter()
        .map(|(pid, process)| RawProcess {
            pid: pid.as_u32(),
            parent_pid: process.parent().map(|parent| parent.as_u32()),
            exe: process.exe().map(|exe| exe.to_string_lossy().into_owned()),
            name: process.name().to_string_lossy().into_owned(),
            cmd: process
                .cmd()
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect(),
            memory_bytes: process.memory(),
            started_at: process.start_time(),
        })
        .collect()
}

/// Resolves the storage roots from the environment.
pub fn resolve_paths(home: Option<PathBuf>) -> PathEnv {
    let codex_home = std::env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let xdg_data = std::env::var_os("XDG_DATA_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    paths_for(home, codex_home, xdg_data)
}

/// The pure root-resolution rule, with the environment already read.
fn paths_for(
    home: Option<PathBuf>,
    codex_home: Option<PathBuf>,
    xdg_data: Option<PathBuf>,
) -> PathEnv {
    let Some(home) = home else {
        return PathEnv::default();
    };

    PathEnv {
        codex_home: Some(codex_home.unwrap_or_else(|| home.join(".codex"))),
        opencode_data: Some(
            xdg_data
                .unwrap_or_else(|| home.join(".local").join("share"))
                .join("opencode"),
        ),
    }
}

/// The capability behind the `processInsights` request.
pub fn read_insights() -> ProcessInsights {
    let home = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let now = crate::shared::clock::Clock::now_ms(&crate::shared::clock::SystemClock);

    let processes = snapshot_processes();
    // Only the tool pids the groups will actually show are scanned: one
    // `lsof` call, never the whole table.
    let mut scan_pids: Vec<u32> = Vec::new();
    for (executable, _) in TRACKED_TOOLS {
        scan_pids.extend(select_tool(&processes, executable).iter().map(|p| p.pid));
    }
    let ports = scan_ports(&scan_pids);

    build_report(&processes, &resolve_paths(home), ports, now.max(0) as u64)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;

    fn process(pid: u32, name: &str, exe: Option<&str>) -> RawProcess {
        RawProcess {
            pid,
            parent_pid: None,
            exe: exe.map(str::to_owned),
            name: name.to_owned(),
            cmd: Vec::new(),
            memory_bytes: 1024,
            started_at: 1_700_000_000,
        }
    }

    // --- normalized_stem -------------------------------------------------

    #[test]
    fn a_stem_is_lowercase_and_directory_free() {
        assert_eq!(normalized_stem("/opt/homebrew/bin/opencode"), "opencode");
        assert_eq!(normalized_stem("Codex"), "codex");
        assert_eq!(normalized_stem(r"C:\tools\codex.exe"), "codex");
    }

    // --- matching --------------------------------------------------------

    #[test]
    fn a_tool_matches_on_executable_name_and_process_name() {
        let by_exe = process(1, "node", Some("/usr/local/bin/codex"));
        let by_name = process(2, "codex", None);
        assert!(matches_tool(&by_exe, "codex"));
        assert!(matches_tool(&by_name, "codex"));
    }

    #[test]
    fn a_tool_matches_through_wrapper_arguments() {
        let wrapped = RawProcess {
            cmd: vec!["/usr/local/bin/npx".into(), "codex".into()],
            ..process(3, "node", Some("/usr/local/bin/npx"))
        };
        assert!(matches_tool(&wrapped, "codex"));
    }

    #[test]
    fn a_wrapper_path_argument_matches_through_a_runtime() {
        let wrapped = RawProcess {
            cmd: vec![
                "/usr/local/bin/bun".into(),
                "/usr/local/bin/opencode".into(),
            ],
            ..process(7, "bun", Some("/usr/local/bin/bun"))
        };
        assert!(matches_tool(&wrapped, "opencode"));
    }

    #[test]
    fn an_unrelated_command_mentioning_the_tool_does_not_match() {
        // `rg codex src/` takes the tool name as a bare argument; listing it
        // under Codex would put an unrelated process in the panel.
        let searcher = RawProcess {
            cmd: vec!["/usr/local/bin/rg".into(), "codex".into(), "src/".into()],
            ..process(4, "rg", Some("/usr/local/bin/rg"))
        };
        assert!(!matches_tool(&searcher, "codex"));

        let grep = RawProcess {
            cmd: vec!["/usr/bin/grep".into(), "codex".into(), "log.txt".into()],
            ..process(5, "grep", Some("/usr/bin/grep"))
        };
        assert!(!matches_tool(&grep, "codex"));
    }

    #[test]
    fn a_similar_name_is_not_a_match() {
        let notes = process(4, "codex-notes", Some("/tmp/codex-notes.txt"));
        assert!(!matches_tool(&notes, "codex"));
        let other = process(5, "opencode-dev", Some("/bin/opencode-dev"));
        assert!(!matches_tool(&other, "codex"));
    }

    #[test]
    fn matching_survives_a_windows_suffix_and_case() {
        let exe = process(6, "codex.exe", Some(r"C:\bin\CODEX.EXE"));
        assert!(matches_tool(&exe, "codex"));
    }

    #[test]
    fn a_spawned_tool_process_belongs_to_its_tool_wherever_it_came_from() {
        let server = RawProcess {
            parent_pid: Some(10),
            ..process(16, "codex", Some("/usr/local/bin/codex"))
        };
        let all = [process(10, "agentgauge", None), server];
        assert_eq!(
            select_tool(&all, "codex")
                .iter()
                .map(|p| p.pid)
                .collect::<Vec<_>>(),
            [16]
        );
    }

    #[test]
    fn tool_selection_never_crosses_tools() {
        let codex = process(20, "codex", Some("/usr/local/bin/codex"));
        let opencode = process(21, "opencode", Some("/opt/homebrew/bin/opencode"));
        let all = [codex, opencode];
        assert_eq!(select_tool(&all, "codex").len(), 1);
        assert_eq!(select_tool(&all, "opencode").len(), 1);
    }

    // --- storage ---------------------------------------------------------

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("agentgauge-process-insights-tests")
            .join(format!("{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("creates the fixture root");
        dir
    }

    #[test]
    fn a_walk_sums_file_lengths_and_counts_only_files() {
        let root = temp_root("walk");
        fs::write(root.join("a.json"), vec![0u8; 100]).expect("writes a");
        fs::create_dir(root.join("nested")).expect("creates nested");
        fs::write(root.join("nested").join("b.json"), vec![0u8; 50]).expect("writes b");

        let walked = walk_size(&root).expect("walks");
        assert_eq!(walked.bytes, 150);
        assert_eq!(walked.file_count, 2);
    }

    #[test]
    fn a_missing_root_is_an_error_not_zero() {
        let missing = std::env::temp_dir().join("agentgauge-never-exists");
        assert!(walk_size(&missing).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_never_followed() {
        let root = temp_root("symlink");
        let target = temp_root("symlink-target");
        fs::write(target.join("big.bin"), vec![0u8; 4096]).expect("writes target");
        std::os::unix::fs::symlink(&target, root.join("link")).expect("links");

        let walked = walk_size(&root).expect("walks");
        assert_eq!(walked.bytes, 0);
        assert_eq!(walked.file_count, 0);
    }

    #[test]
    fn measuring_reports_components_and_the_rest_separately() {
        let root = temp_root("measure");
        fs::write(root.join("state.sqlite"), vec![0u8; 10]).expect("writes db");
        fs::create_dir(root.join("sessions")).expect("creates sessions");
        fs::write(root.join("sessions").join("rollout.jsonl"), vec![0u8; 90])
            .expect("writes rollout");

        let report = measure_storage(
            &root,
            &[
                Component::Directory {
                    label: "Sessions",
                    name: "sessions",
                },
                Component::SqliteFiles {
                    label: "Databases (SQLite)",
                },
            ],
        );
        let StorageReport::Measured {
            total_bytes,
            total_files,
            rows,
        } = report
        else {
            panic!("expected a measured report");
        };
        assert_eq!(total_bytes, 100);
        assert_eq!(total_files, 2);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].label, "Sessions");
        assert_eq!(rows[0].bytes, 90);
        assert_eq!(rows[1].label, "Databases (SQLite)");
        assert_eq!(rows[1].bytes, 10);
        assert_eq!(rows[1].path, "state.sqlite");
        assert_eq!(rows[2].label, "Everything else");
        assert_eq!(rows[2].bytes, 0);
    }

    #[test]
    fn a_database_row_counts_wal_and_shm_siblings_but_not_lookalikes() {
        let root = temp_root("sqlite-siblings");
        fs::write(root.join("opencode.db"), vec![0u8; 100]).expect("writes db");
        fs::write(root.join("opencode.db-wal"), vec![0u8; 20]).expect("writes wal");
        fs::write(root.join("opencode.db-shm"), vec![0u8; 5]).expect("writes shm");
        fs::write(root.join("state_5.sqlite"), vec![0u8; 7]).expect("writes state");
        fs::write(root.join("not-a-db.sqlitebackup"), vec![0u8; 1000]).expect("writes lookalike");

        let report = measure_storage(
            &root,
            &[Component::SqliteFiles {
                label: "Databases (SQLite)",
            }],
        );
        let StorageReport::Measured { rows, .. } = report else {
            panic!("expected a measured report");
        };
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].bytes, 132);
        assert_eq!(rows[0].file_count, 4);
        assert!(rows[0].path.contains("opencode.db"));
        assert!(rows[0].path.contains("state_5.sqlite"));
        assert!(!rows[0].path.contains("sqlitebackup"));
        assert_eq!(rows[1].label, "Everything else");
        assert_eq!(rows[1].bytes, 1000);
    }

    #[test]
    fn a_database_row_is_omitted_when_the_tool_stores_none() {
        let root = temp_root("sqlite-none");
        fs::write(root.join("history.jsonl"), vec![0u8; 5]).expect("writes history");
        let report = measure_storage(
            &root,
            &[Component::SqliteFiles {
                label: "Databases (SQLite)",
            }],
        );
        let StorageReport::Measured { rows, .. } = report else {
            panic!("expected a measured report");
        };
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "Everything else");
    }

    #[test]
    fn an_absent_root_is_reported_absent_with_a_reason() {
        let report = measure_storage(
            &std::env::temp_dir().join("agentgauge-never-exists"),
            &[Component::Directory {
                label: "Sessions",
                name: "sessions",
            }],
        );
        assert!(matches!(report, StorageReport::Absent { .. }));
    }

    #[test]
    fn a_tool_without_a_defined_root_reports_that_instead_of_another_tools() {
        let report = tool_storage("claude", &PathEnv::default());
        let StorageReport::Absent { reason } = report else {
            panic!("expected an absent report");
        };
        assert!(reason.contains("claude"));
        assert!(!reason.contains("opencode"));
    }

    #[test]
    fn a_missing_component_is_omitted_rather_than_listed_as_zero() {
        let root = temp_root("partial");
        fs::write(root.join("history.jsonl"), vec![0u8; 5]).expect("writes history");
        let report = measure_storage(
            &root,
            &[Component::Directory {
                label: "Sessions",
                name: "sessions",
            }],
        );
        let StorageReport::Measured { rows, .. } = report else {
            panic!("expected a measured report");
        };
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "Everything else");
    }

    // --- the report ------------------------------------------------------

    #[test]
    fn the_report_lists_only_the_tool_groups_in_order() {
        let root = temp_root("report");
        fs::write(root.join("settings.json"), vec![0u8; 3]).expect("writes settings");
        let insights = build_report(
            &[process(10, "agentgauge", None), process(11, "codex", None)],
            &PathEnv {
                codex_home: Some(root.join("codex-home-absent")),
                opencode_data: None,
            },
            PortScan::Checked {
                listening: Vec::new(),
            },
            1_700_000_000_000,
        );
        let ids: Vec<&str> = insights.groups.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, ["codex", "opencode"]);
        assert_eq!(insights.fetched_at, 1_700_000_000_000);
        // The app's own processes belong to no group: the screen is for the
        // toolchain's cost, not ours.
        assert!(insights
            .groups
            .iter()
            .all(|g| !g.processes.iter().any(|p| p.pid == 10)));
    }

    #[test]
    fn a_group_with_no_processes_is_an_explicit_empty_list() {
        let insights = build_report(
            &[],
            &PathEnv::default(),
            PortScan::Checked {
                listening: Vec::new(),
            },
            0,
        );
        let codex = insights
            .groups
            .iter()
            .find(|g| g.id == "codex")
            .expect("codex group exists");
        assert!(codex.processes.is_empty());
        assert!(matches!(codex.storage, StorageReport::Absent { .. }));
    }

    #[test]
    fn totals_sum_the_selected_processes() {
        let root = temp_root("totals");
        fs::write(root.join("x"), vec![0u8; 1]).expect("writes x");
        let mut a = process(10, "codex", Some("/usr/local/bin/codex"));
        a.memory_bytes = 300;
        let mut b = RawProcess {
            parent_pid: Some(10),
            ..process(11, "codex", Some("/usr/local/bin/codex"))
        };
        b.memory_bytes = 100;
        let insights = build_report(
            &[a, b],
            &PathEnv {
                codex_home: Some(root),
                opencode_data: None,
            },
            PortScan::Checked {
                listening: Vec::new(),
            },
            0,
        );
        assert_eq!(insights.groups[0].total_memory_bytes, 400);
        assert_eq!(insights.groups[0].processes.len(), 2);
    }

    #[test]
    fn a_long_command_is_capped_and_an_empty_one_is_absent() {
        let long: Vec<String> = vec!["argument".to_owned(); 100];
        let capped = display_command(&long).expect("capped");
        assert!(capped.chars().count() <= MAX_COMMAND_CHARS);
        assert_eq!(display_command(&[]), None);
    }

    #[test]
    fn the_wire_shape_is_camel_case_for_the_renderer() {
        let summary = ProcessSummary {
            pid: 1,
            name: "codex".into(),
            command: Some("codex app-server".into()),
            started_at: Some(1_700_000_000),
            memory_bytes: Some(2048),
            listening_ports: Vec::new(),
        };
        let value = serde_json::to_value(&summary).expect("serializes");
        assert_eq!(value["startedAt"], 1_700_000_000);
        assert_eq!(value["memoryBytes"], 2048);

        let checked = serde_json::to_value(PortScan::Checked {
            listening: vec![ProcessPort {
                pid: 12966,
                port: 49374,
            }],
        })
        .expect("serializes");
        assert_eq!(checked["state"], "checked");
        assert_eq!(checked["listening"][0]["pid"], 12966);
        assert_eq!(checked["listening"][0]["port"], 49374);

        let unavailable = serde_json::to_value(PortScan::Unavailable {
            reason: "lsof was not found.".into(),
        })
        .expect("serializes");
        assert_eq!(unavailable["state"], "unavailable");
        assert_eq!(unavailable["reason"], "lsof was not found.");

        let absent = serde_json::to_value(StorageReport::Absent {
            reason: "Not created yet.".into(),
        })
        .expect("serializes");
        assert_eq!(absent["state"], "absent");
        assert_eq!(absent["reason"], "Not created yet.");

        let measured = serde_json::to_value(StorageReport::Measured {
            total_bytes: 10,
            total_files: 1,
            rows: Vec::new(),
        })
        .expect("serializes");
        assert_eq!(measured["state"], "measured");
        assert_eq!(measured["totalBytes"], 10);
    }

    // --- listening ports -------------------------------------------------

    #[test]
    fn lsof_field_output_parses_into_pid_port_pairs() {
        let raw = "p12966\ncopencode\nf7\nn127.0.0.1:49374\np12964\ncopencode\nf12\nn[::1]:4096\n";
        assert_eq!(
            parse_lsof_ports(raw),
            vec![
                ProcessPort {
                    pid: 12966,
                    port: 49374
                },
                ProcessPort {
                    pid: 12964,
                    port: 4096
                },
            ]
        );
    }

    #[test]
    fn an_empty_lsof_answer_is_a_checked_scan_with_nothing_listening() {
        assert_eq!(parse_lsof_ports(""), Vec::new());
        assert_eq!(parse_lsof_ports("p11621\ncodex\n"), Vec::new());
    }

    #[test]
    fn a_portless_node_line_is_skipped_rather_than_guessed() {
        assert_eq!(parse_lsof_ports("p12966\nn*\n"), Vec::new());
    }

    #[test]
    fn a_process_summary_carries_its_own_sorted_listening_ports() {
        let server = RawProcess {
            cmd: vec!["opencode".into(), "serve".into()],
            ..process(12966, "opencode", Some("/opt/homebrew/bin/opencode"))
        };
        let insights = build_report(
            &[server],
            &PathEnv::default(),
            PortScan::Checked {
                listening: vec![
                    ProcessPort {
                        pid: 12966,
                        port: 49375,
                    },
                    ProcessPort {
                        pid: 12966,
                        port: 49374,
                    },
                ],
            },
            0,
        );
        let opencode = insights
            .groups
            .iter()
            .find(|g| g.id == "opencode")
            .expect("group");
        let summary = &opencode.processes[0];
        assert_eq!(summary.listening_ports, [49374, 49375]);
        match &opencode.ports {
            PortScan::Checked { listening } => assert_eq!(listening.len(), 2),
            PortScan::Unavailable { .. } => panic!("expected a checked scan"),
        }
    }

    #[test]
    fn a_port_scan_unavailability_is_carried_through_to_the_group() {
        let server = process(10, "codex", Some("/usr/local/bin/codex"));
        let insights = build_report(
            &[server],
            &PathEnv::default(),
            PortScan::Unavailable {
                reason: "lsof was not found.".into(),
            },
            0,
        );
        let codex = insights
            .groups
            .iter()
            .find(|g| g.id == "codex")
            .expect("group");
        match &codex.ports {
            PortScan::Checked { .. } => panic!("expected an unavailable scan"),
            PortScan::Unavailable { reason } => assert!(reason.contains("lsof")),
        }
        assert!(codex.processes[0].listening_ports.is_empty());
    }

    #[test]
    fn roots_resolve_from_home_with_overrides_honoured() {
        let home = PathBuf::from("/tmp/fake-home");
        let paths = paths_for(
            Some(home.clone()),
            Some(PathBuf::from("/custom/codex")),
            Some(PathBuf::from("/custom/data")),
        );
        assert_eq!(paths.codex_home, Some(PathBuf::from("/custom/codex")));
        assert_eq!(
            paths.opencode_data,
            Some(PathBuf::from("/custom/data/opencode"))
        );

        let defaults = paths_for(Some(home), None, None);
        assert_eq!(
            defaults.codex_home,
            Some(PathBuf::from("/tmp/fake-home/.codex"))
        );
        assert_eq!(
            defaults.opencode_data,
            Some(PathBuf::from("/tmp/fake-home/.local/share/opencode"))
        );
    }

    #[test]
    fn without_a_home_no_storage_root_is_known() {
        let paths = paths_for(None, None, None);
        assert!(paths.codex_home.is_none());
        assert!(paths.opencode_data.is_none());
    }

    #[test]
    fn a_live_snapshot_contains_this_process() {
        let snapshot = snapshot_processes();
        assert!(
            snapshot.iter().any(|p| p.pid == std::process::id()),
            "the snapshot must contain the test's own process"
        );
    }

    #[test]
    fn a_live_read_lists_only_the_tool_groups() {
        let insights = read_insights();
        assert_eq!(insights.groups.len(), TRACKED_TOOLS.len());
        assert_eq!(
            insights
                .groups
                .iter()
                .map(|g| g.id.as_str())
                .collect::<Vec<_>>(),
            ["codex", "opencode"]
        );
        assert!(
            insights
                .groups
                .iter()
                .all(|g| !g.processes.iter().any(|p| p.pid == std::process::id())),
            "the asking process belongs to no group"
        );
    }
}
