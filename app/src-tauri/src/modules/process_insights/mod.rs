//! Read-only process and storage insights for the agent toolchain.
//!
//! One bounded capability: a snapshot of what Codex and OpenCode are doing
//! to this machine — running processes with their memory, CPU share, age,
//! and listening ports (with the interface each port is bound to), and the
//! on-disk footprint each one owns, broken into the components the tools
//! actually create. The app itself is deliberately not a group: the screen
//! is for the toolchain's cost, not ours. Everything here is a read; there
//! is deliberately no capability to stop, signal, or delete anything.
//!
//! [`RawProcess`] is the provider-agnostic process record. The matching and
//! grouping functions over it are pure and unit-tested; the `sysinfo` adapter
//! is a thin translation at the edge so the logic can be exercised without a
//! live process table. Storage is measured with a plain filesystem walk —
//! logical file sizes, symlinks not followed — and an unreadable subtree
//! contributes nothing rather than failing the whole read. Roots the tools
//! relocated through their environment (`CODEX_SQLITE_HOME`,
//! `OPENCODE_DB`) are measured beside the data directory and reported as
//! rows outside the root's total, never folded into it.

use std::cmp::Reverse;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One running process, as the renderer renders it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    /// The process's CPU share over the read's sampling interval, in percent
    /// of one core — above 100 means several cores. `None` when the platform
    /// did not report a sample.
    pub cpu_usage: Option<f32>,
    /// Present only for states a user must know about (`stopped`, `zombie`,
    /// `dead`); normal states carry nothing so routine rows stay untagged.
    pub status: Option<String>,
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
    /// The interface the socket is bound to (`127.0.0.1`, `::1`, `*` for
    /// every interface). `None` when the node did not name one.
    pub address: Option<String>,
}

/// The running OpenCode background service, as recorded by the tool itself in
/// its state directory (`service.json`; `server.json` on dev builds).
///
/// Only `version`, `url`, and `pid` are read. The sibling `password` field is
/// a secret: it is deliberately never parsed, stored, or logged, so it cannot
/// reach the renderer by construction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub version: Option<String>,
    pub url: Option<String>,
    pub pid: Option<u32>,
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
        /// Footprint the tool relocated outside the data directory through
        /// its own environment (`CODEX_SQLITE_HOME`, `OPENCODE_DB`). These
        /// bytes are deliberately **not** part of `total_bytes` — the total
        /// describes the walked root and nothing else.
        external_rows: Vec<StorageRow>,
    },
    Absent {
        reason: String,
    },
}

/// Everything the screen shows about one group of processes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessGroup {
    pub id: String,
    pub display_name: String,
    pub processes: Vec<ProcessSummary>,
    pub total_memory_bytes: u64,
    /// The group's summed CPU share, `None` when no member reported a sample.
    pub total_cpu_usage: Option<f32>,
    pub storage: StorageReport,
    /// Whether and where this group's processes are listening on TCP.
    pub ports: PortScan,
    /// The tool's self-recorded background service, attached only when its
    /// recorded pid is one of this group's live processes.
    pub service: Option<ServiceInfo>,
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
#[derive(Debug, Clone, PartialEq)]
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
    /// Percent of one core over the sampling interval; filled only for the
    /// tracked tools' processes, whose pids are sampled twice.
    pub cpu_usage: Option<f32>,
    /// Only abnormal states (`stopped`, `zombie`, `dead`); normal is `None`.
    pub status: Option<String>,
}

/// The roots each group's storage is measured from.
///
/// Resolved by the caller so tests inject temporary directories; `None`
/// means the root cannot be known (no home directory), which renders as an
/// absent footprint with a reason. The relocation fields are `Some` only
/// when the tool's own environment moved that footprint elsewhere.
#[derive(Debug, Clone, Default)]
pub struct PathEnv {
    pub codex_home: Option<PathBuf>,
    /// `$CODEX_SQLITE_HOME`, when set: where Codex keeps its runtime SQLite
    /// databases and their backups, outside `codex_home`.
    pub codex_sqlite_home: Option<PathBuf>,
    pub opencode_data: Option<PathBuf>,
    /// `$OPENCODE_DB`, when set: the file OpenCode was told to keep its
    /// database in, outside `opencode_data`.
    pub opencode_db: Option<PathBuf>,
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
/// tool rides in its arguments. A shell `-c` script matches on its **first
/// token** only (`sh -c "opencode serve"` is OpenCode; `sh -c "echo
/// codex"` is not), because a bare mention deeper in a script is as often a
/// reference as a launch. For anything else an argument is just a mention:
/// `rg codex src/` takes the name as a bare argument and must not land in
/// Codex's panel.
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
    if launched_by_runtime(process)
        && process
            .cmd
            .iter()
            .any(|arg| normalized_stem(arg) == executable)
    {
        return true;
    }
    dash_c_first_token(&process.cmd).is_some_and(|token| normalized_stem(&token) == executable)
}

/// The first token of a shell `-c` script, when the command is one.
///
/// Only the token that names the program to run decides the match; every
/// later token is an argument or a mention.
fn dash_c_first_token(cmd: &[String]) -> Option<String> {
    let first = cmd.first()?;
    if !matches!(
        normalized_stem(first).as_str(),
        "sh" | "bash" | "zsh" | "dash"
    ) {
        return None;
    }
    let mut arguments = cmd[1..].iter();
    while let Some(argument) = arguments.next() {
        if argument == "-c" {
            return arguments
                .next()?
                .split_whitespace()
                .next()
                .map(str::to_owned);
        }
    }
    None
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
#[derive(Debug, Clone)]
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
/// can dwarf the main file between checkpoints. Only those two suffixes
/// extend a database file; anything else must end in `.sqlite` or `.db`
/// itself, so a lookalike (`foo.sqlitebackup`, `notes.db-old`) is not one.
fn is_database_file(name: &str) -> bool {
    let base = name
        .strip_suffix("-wal")
        .or_else(|| name.strip_suffix("-shm"))
        .unwrap_or(name);
    base.ends_with(".sqlite") || base.ends_with(".db")
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
/// the rows always sum to the total. `external` rows describe footprint the
/// tool keeps outside the root and are carried beside the report without
/// touching its arithmetic.
fn measure_storage(
    root: &Path,
    components: &[Component],
    external: Vec<StorageRow>,
) -> StorageReport {
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
        external_rows: external,
    }
}

/// The root-level SQLite files at `base`, as one labelled row.
fn sqlite_row_at(base: &Path, label: &str) -> Option<StorageRow> {
    walk_sqlite_files(base).map(|(walked, names)| StorageRow {
        label: label.to_owned(),
        path: names.join(", "),
        bytes: walked.bytes,
        file_count: walked.file_count,
    })
}

/// One whole walked directory, as one labelled row.
fn directory_row(dir: &Path, label: &str) -> Option<StorageRow> {
    walk_size(dir).ok().map(|walked| StorageRow {
        label: label.to_owned(),
        path: dir.display().to_string(),
        bytes: walked.bytes,
        file_count: walked.file_count,
    })
}

/// One database file plus its `-wal`/`-shm` siblings, as one labelled row.
///
/// This is the shape of a relocation that names a file (`OPENCODE_DB`):
/// the journal files live beside the database wherever it was moved.
fn database_file_row(file: &Path, label: &str) -> Option<StorageRow> {
    if !file.is_file() {
        return None;
    }
    let mut bytes = 0;
    let mut names = Vec::new();
    for candidate in [
        file.to_path_buf(),
        PathBuf::from(format!("{}-wal", file.display())),
        PathBuf::from(format!("{}-shm", file.display())),
    ] {
        let name = candidate.file_name()?.to_string_lossy().into_owned();
        if !is_database_file(&name) {
            continue;
        }
        if let Ok(metadata) = std::fs::symlink_metadata(&candidate) {
            if metadata.is_file() {
                bytes += metadata.len();
                names.push(name);
            }
        }
    }
    if names.is_empty() {
        return None;
    }
    names.sort_unstable();
    Some(StorageRow {
        label: label.to_owned(),
        path: names.join(", "),
        bytes,
        file_count: names.len() as u64,
    })
}

/// One tracked tool's footprint, from its resolved data root.
///
/// An executable with no defined root reports exactly that. It must never
/// fall through to another tool's directories: a future tracked tool that
/// reaches here without storage support would otherwise display OpenCode's
/// footprint under its own name, and nothing would look wrong.
///
/// Codex relocates its runtime databases (and their backups) to
/// `$CODEX_SQLITE_HOME` when that environment variable is set —
/// env-relocation only, because a `sqlite_home` set inside `config.toml` is
/// not visible to a read that does not parse config. OpenCode's
/// `$OPENCODE_DB` names a database file. Relocated bytes are reported as
/// rows outside the root's total, never folded into it.
fn tool_storage(executable: &str, paths: &PathEnv) -> StorageReport {
    match executable {
        "codex" => codex_storage(paths),
        "opencode" => opencode_storage(paths),
        other => StorageReport::Absent {
            reason: format!("No data directory is defined for `{other}` in this build."),
        },
    }
}

/// The components every Codex installation creates inside `$CODEX_HOME`,
/// verified against the vendored source and the real directory.
fn codex_components() -> Vec<Component> {
    [
        Component::Directory {
            label: "Session transcripts",
            name: "sessions",
        },
        Component::Directory {
            label: "Archived transcripts",
            name: "archived_sessions",
        },
        Component::Directory {
            label: "Cache",
            name: "cache",
        },
        Component::Directory {
            label: "Temporary files",
            name: ".tmp",
        },
        Component::Directory {
            label: "Generated images",
            name: "generated_images",
        },
        Component::Directory {
            label: "Plugins",
            name: "plugins",
        },
        Component::Directory {
            label: "Logs",
            name: "log",
        },
    ]
    .to_vec()
}

/// The components every OpenCode installation creates inside its data
/// directory, verified against the vendored source and the real directory.
/// `storage` is the legacy JSON store (absent on v2's SQLite-only installs,
/// which simply omit the row).
fn opencode_components() -> Vec<Component> {
    [
        Component::Directory {
            label: "Session storage",
            name: "storage",
        },
        Component::Directory {
            label: "Logs",
            name: "log",
        },
        Component::Directory {
            label: "Project snapshots (git)",
            name: "snapshot",
        },
        Component::Directory {
            label: "Shell histories",
            name: "shell",
        },
        Component::Directory {
            label: "Spilled tool output",
            name: "tool-output",
        },
    ]
    .to_vec()
}

fn codex_storage(paths: &PathEnv) -> StorageReport {
    let Some(root) = paths.codex_home.as_deref() else {
        return StorageReport::Absent {
            reason: "No home directory is available, so the data directory cannot be located."
                .to_owned(),
        };
    };
    if !root.exists() {
        return StorageReport::Absent {
            reason: format!("Codex has not created `{}` yet.", root.display()),
        };
    }

    let relocated = paths
        .codex_sqlite_home
        .as_deref()
        .filter(|sqlite_home| *sqlite_home != root);

    let mut components = codex_components();
    let mut external = Vec::new();
    match relocated {
        Some(sqlite_home) => {
            if let Some(row) = sqlite_row_at(
                sqlite_home,
                "Databases (SQLite) — relocated via CODEX_SQLITE_HOME",
            ) {
                external.push(row);
            }
            if let Some(row) = directory_row(
                &sqlite_home.join("db-backups"),
                "Database backups — relocated via CODEX_SQLITE_HOME",
            ) {
                external.push(row);
            }
        }
        None => {
            components.push(Component::SqliteFiles {
                label: "Databases (SQLite)",
            });
            components.push(Component::Directory {
                label: "Database backups",
                name: "db-backups",
            });
        }
    }

    measure_storage(root, &components, external)
}

fn opencode_storage(paths: &PathEnv) -> StorageReport {
    let Some(root) = paths.opencode_data.as_deref() else {
        return StorageReport::Absent {
            reason: "No home directory is available, so the data directory cannot be located."
                .to_owned(),
        };
    };
    if !root.exists() {
        return StorageReport::Absent {
            reason: format!("OpenCode has not created `{}` yet.", root.display()),
        };
    }

    let mut components = opencode_components();
    components.push(Component::SqliteFiles {
        label: "Databases (SQLite)",
    });

    let mut external = Vec::new();
    if let Some(database) = paths
        .opencode_db
        .as_deref()
        .filter(|database| !database.starts_with(root))
    {
        if let Some(row) =
            database_file_row(database, "Databases (SQLite) — relocated via OPENCODE_DB")
        {
            external.push(row);
        }
    }

    measure_storage(root, &components, external)
}

/// Parses `lsof -F pcn` output into pid/port pairs with the bound interface.
///
/// A `p` line starts a process record; the `n` lines that follow are its
/// nodes (`127.0.0.1:49374`, `*:4096`, `[::1]:4096`), and only nodes ending
/// in a parseable port count — portless forms like `*` alone are skipped.
/// Unparseable pids are skipped rather than guessed.
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
            let Some((address, port)) = split_node(node) else {
                continue;
            };
            ports.push(ProcessPort { pid, port, address });
        }
    }

    ports
}

/// Splits an `lsof` node into its bound interface and port.
///
/// IPv6 nodes arrive bracketed (`[::1]:4096`); the interface inside the
/// brackets is the address and never contains a colon to split on.
fn split_node(node: &str) -> Option<(Option<String>, u16)> {
    if let Some(rest) = node.strip_prefix('[') {
        let close = rest.find(']')?;
        let address = &rest[..close];
        let port = rest[close + 1..].strip_prefix(':')?.parse().ok()?;
        return Some((Some(address.to_owned()), port));
    }

    let (address, port) = node.rsplit_once(':')?;
    let port = port.parse().ok()?;
    Some((Some(address.to_owned()), port))
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
/// The port scan and the tool's self-recorded service are passed in rather
/// than read here so report assembly stays pure: tests inject both,
/// production injects [`scan_ports`]'s answer for exactly the pids the
/// groups selected and whatever [`read_opencode_service`] found. Only the
/// tracked tools have groups — the app's own processes belong to none of
/// them, so this process, any other `agentgauge` binary, and the widget
/// extension simply do not appear.
///
/// Rows are ordered by memory, heaviest first: the screen's question is
/// what the toolchain costs this machine, and the expensive rows are the
/// answer.
pub fn build_report(
    processes: &[RawProcess],
    paths: &PathEnv,
    ports: PortScan,
    service: Option<ServiceInfo>,
    now_ms: u64,
) -> ProcessInsights {
    let mut groups = Vec::with_capacity(TRACKED_TOOLS.len());

    for (executable, display_name) in TRACKED_TOOLS {
        let mut selected = select_tool(processes, executable);
        selected.sort_by_key(|process| Reverse(process.memory_bytes));
        let total_cpu_usage = selected
            .iter()
            .filter_map(|process| process.cpu_usage)
            .reduce(|sum, usage| sum + usage)
            .filter(|total| total.is_finite());
        groups.push(ProcessGroup {
            id: executable.to_owned(),
            display_name: display_name.to_owned(),
            total_memory_bytes: selected.iter().map(|process| process.memory_bytes).sum(),
            total_cpu_usage,
            processes: selected
                .iter()
                .map(|process| summarize(process, &ports_for_pid(&ports, process.pid)))
                .collect(),
            storage: tool_storage(executable, paths),
            ports: group_ports(&ports, &selected),
            service: live_service(executable, &selected, service.as_ref()),
        });
    }

    ProcessInsights {
        fetched_at: now_ms,
        groups,
    }
}

/// The service line this group may show: the tool's own record, attached
/// only when the pid it names is one of the group's live processes, so the
/// screen can never describe a service that is no longer running.
fn live_service(
    executable: &str,
    selected: &[RawProcess],
    service: Option<&ServiceInfo>,
) -> Option<ServiceInfo> {
    if executable != "opencode" {
        return None;
    }
    service
        .filter(|service| {
            service
                .pid
                .is_some_and(|pid| selected.iter().any(|process| process.pid == pid))
        })
        .cloned()
}

/// One process summarized for the wire.
fn summarize(process: &RawProcess, listening_ports: &[u16]) -> ProcessSummary {
    ProcessSummary {
        pid: process.pid,
        name: process.name.clone(),
        command: display_command(&process.cmd),
        started_at: Some(process.started_at),
        memory_bytes: Some(process.memory_bytes),
        cpu_usage: process.cpu_usage,
        status: process.status.clone(),
        listening_ports: listening_ports.to_vec(),
    }
}

/// The command line joined and capped, or `None` when nothing was reported.
///
/// A capped line ends in an ellipsis so the cut is visible as a cut.
fn display_command(cmd: &[String]) -> Option<String> {
    if cmd.is_empty() {
        return None;
    }
    let joined = cmd.join(" ");
    if joined.chars().count() > MAX_COMMAND_CHARS {
        let capped: String = joined.chars().take(MAX_COMMAND_CHARS - 1).collect();
        Some(format!("{capped}…"))
    } else {
        Some(joined)
    }
}

/// The process states a user must know about; every other state is a
/// process behaving normally and carries no tag.
fn abnormal_status(status: sysinfo::ProcessStatus) -> Option<String> {
    match status {
        sysinfo::ProcessStatus::Stop => Some("stopped".to_owned()),
        sysinfo::ProcessStatus::Zombie => Some("zombie".to_owned()),
        sysinfo::ProcessStatus::Dead => Some("dead".to_owned()),
        _ => None,
    }
}

/// Reads a live snapshot of every process the platform reports.
///
/// CPU share is a rate, so the tracked tools' pids are sampled twice with
/// the platform's minimum interval between the passes — only those pids,
/// because nobody else's CPU reaches the screen. The second pass is what
/// makes `cpu_usage` meaningful; a single refresh reports no interval at
/// all.
fn snapshot_processes() -> Vec<RawProcess> {
    use sysinfo::{ProcessesToUpdate, System};

    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);

    let mut processes: Vec<RawProcess> = system
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
            cpu_usage: None,
            status: None,
        })
        .collect();

    let tracked: Vec<sysinfo::Pid> = TRACKED_TOOLS
        .iter()
        .flat_map(|(executable, _)| select_tool(&processes, executable))
        .map(|process| sysinfo::Pid::from_u32(process.pid))
        .collect();
    if tracked.is_empty() {
        return processes;
    }

    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
    system.refresh_processes(ProcessesToUpdate::Some(&tracked), true);
    for process in &mut processes {
        if !tracked.contains(&sysinfo::Pid::from_u32(process.pid)) {
            continue;
        }
        let Some(fresh) = system.process(sysinfo::Pid::from_u32(process.pid)) else {
            continue;
        };
        let usage = fresh.cpu_usage();
        if usage.is_finite() {
            process.cpu_usage = Some(usage);
        }
        process.status = abnormal_status(fresh.status());
    }

    processes
}

/// Resolves the storage roots from the environment.
pub fn resolve_paths(home: Option<PathBuf>) -> PathEnv {
    let codex_home = non_empty_env("CODEX_HOME").map(PathBuf::from);
    let codex_sqlite_home = non_empty_env("CODEX_SQLITE_HOME").map(PathBuf::from);
    let xdg_data = non_empty_env("XDG_DATA_HOME").map(PathBuf::from);
    let opencode_db = non_empty_env("OPENCODE_DB").map(PathBuf::from);
    paths_for(home, codex_home, codex_sqlite_home, xdg_data, opencode_db)
}

/// An environment variable's value when it is set to something.
fn non_empty_env(name: &str) -> Option<String> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string_lossy().into_owned())
}

/// The pure root-resolution rule, with the environment already read.
fn paths_for(
    home: Option<PathBuf>,
    codex_home: Option<PathBuf>,
    codex_sqlite_home: Option<PathBuf>,
    xdg_data: Option<PathBuf>,
    opencode_db: Option<PathBuf>,
) -> PathEnv {
    let Some(home) = home else {
        return PathEnv::default();
    };

    PathEnv {
        codex_home: Some(codex_home.unwrap_or_else(|| home.join(".codex"))),
        codex_sqlite_home,
        opencode_data: Some(
            xdg_data
                .unwrap_or_else(|| home.join(".local").join("share"))
                .join("opencode"),
        ),
        opencode_db,
    }
}

/// Reads the running OpenCode background service's own record, if it left
/// one.
///
/// The installed v2 CLI writes `service.json` and dev builds write
/// `server.json` into the state directory; both carry the live server's id,
/// version, url, pid — and a password, which is a secret and is
/// deliberately never read.
pub fn read_opencode_service(home: Option<&Path>) -> Option<ServiceInfo> {
    let state = non_empty_env("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| home.map(|home| home.join(".local").join("state")))?;
    let root = state.join("opencode");

    for name in ["service.json", "server.json"] {
        if let Ok(text) = std::fs::read_to_string(root.join(name)) {
            if let Some(service) = parse_service(&text) {
                return Some(service);
            }
        }
    }
    None
}

/// Picks exactly the public facts out of a service record.
///
/// The record also carries the server's password; this parser never touches
/// that field, so the secret cannot reach the wire even by accident.
fn parse_service(text: &str) -> Option<ServiceInfo> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    Some(ServiceInfo {
        version: value
            .get("version")
            .and_then(|version| version.as_str())
            .map(str::to_owned),
        url: value
            .get("url")
            .and_then(|url| url.as_str())
            .map(str::to_owned),
        pid: value
            .get("pid")
            .and_then(|pid| pid.as_u64())
            .and_then(|pid| u32::try_from(pid).ok()),
    })
}

/// The capability behind the `processInsights` request.
pub fn read_insights() -> ProcessInsights {
    let home = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let now = crate::shared::clock::Clock::now_ms(&crate::shared::clock::SystemClock);

    let processes = snapshot_processes();
    let mut scan_pids: Vec<u32> = Vec::new();
    for (executable, _) in TRACKED_TOOLS {
        scan_pids.extend(select_tool(&processes, executable).iter().map(|p| p.pid));
    }
    let ports = scan_ports(&scan_pids);
    let service = read_opencode_service(home.as_deref());

    build_report(
        &processes,
        &resolve_paths(home),
        ports,
        service,
        now.max(0) as u64,
    )
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
            cpu_usage: None,
            status: None,
        }
    }

    #[test]
    fn a_stem_is_lowercase_and_directory_free() {
        assert_eq!(normalized_stem("/opt/homebrew/bin/opencode"), "opencode");
        assert_eq!(normalized_stem("Codex"), "codex");
        assert_eq!(normalized_stem(r"C:\tools\codex.exe"), "codex");
    }

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
    fn a_shell_dash_c_script_matches_its_first_token_only() {
        let serving = RawProcess {
            cmd: vec![
                "/bin/sh".into(),
                "-c".into(),
                "opencode serve --hostname 127.0.0.1".into(),
            ],
            ..process(8, "sh", Some("/bin/sh"))
        };
        assert!(matches_tool(&serving, "opencode"));

        let echoing = RawProcess {
            cmd: vec!["/bin/sh".into(), "-c".into(), "echo codex".into()],
            ..process(9, "sh", Some("/bin/sh"))
        };
        assert!(!matches_tool(&echoing, "codex"));

        let non_shell_dash_c = RawProcess {
            cmd: vec!["/usr/sbin/therm".into(), "-c".into(), "codex".into()],
            ..process(10, "therm", Some("/usr/sbin/therm"))
        };
        assert!(!matches_tool(&non_shell_dash_c, "codex"));
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
            Vec::new(),
        );
        let StorageReport::Measured {
            total_bytes,
            total_files,
            rows,
            external_rows,
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
        assert!(external_rows.is_empty());
    }

    #[test]
    fn external_rows_are_carried_without_touching_the_total() {
        let root = temp_root("external");
        fs::write(root.join("history.jsonl"), vec![0u8; 30]).expect("writes history");

        let external = StorageRow {
            label: "Databases (SQLite) — relocated".to_owned(),
            path: "state.sqlite".to_owned(),
            bytes: 500,
            file_count: 1,
        };
        let report = measure_storage(&root, &[], vec![external]);
        let StorageReport::Measured {
            total_bytes, rows, ..
        } = report
        else {
            panic!("expected a measured report");
        };
        assert_eq!(total_bytes, 30, "the total describes the root only");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn a_database_row_counts_wal_and_shm_siblings_but_not_lookalikes() {
        let root = temp_root("sqlite-siblings");
        fs::write(root.join("opencode.db"), vec![0u8; 100]).expect("writes db");
        fs::write(root.join("opencode.db-wal"), vec![0u8; 20]).expect("writes wal");
        fs::write(root.join("opencode.db-shm"), vec![0u8; 5]).expect("writes shm");
        fs::write(root.join("state_5.sqlite"), vec![0u8; 7]).expect("writes state");
        fs::write(root.join("not-a-db.sqlitebackup"), vec![0u8; 1000]).expect("writes lookalike");
        fs::write(root.join("notes.db-old"), vec![0u8; 2000]).expect("writes old backup");

        let report = measure_storage(
            &root,
            &[Component::SqliteFiles {
                label: "Databases (SQLite)",
            }],
            Vec::new(),
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
        assert!(!rows[0].path.contains("notes.db-old"));
        assert_eq!(rows[1].label, "Everything else");
        assert_eq!(rows[1].bytes, 3000);
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
            Vec::new(),
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
            Vec::new(),
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
            Vec::new(),
        );
        let StorageReport::Measured { rows, .. } = report else {
            panic!("expected a measured report");
        };
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "Everything else");
    }

    #[test]
    fn the_real_codex_directories_are_labelled_components() {
        let root = temp_root("codex-components");
        for name in [
            "sessions",
            "archived_sessions",
            "cache",
            ".tmp",
            "generated_images",
            "plugins",
            "log",
            "db-backups",
        ] {
            fs::create_dir(root.join(name)).expect("creates component");
            fs::write(root.join(name).join("f.bin"), vec![0u8; 1]).expect("fills component");
        }
        fs::write(root.join("state.sqlite"), vec![0u8; 2]).expect("writes db");

        let report = tool_storage(
            "codex",
            &PathEnv {
                codex_home: Some(root),
                ..PathEnv::default()
            },
        );
        let StorageReport::Measured { rows, .. } = report else {
            panic!("expected a measured report");
        };
        let labels: Vec<&str> = rows.iter().map(|row| row.label.as_str()).collect();
        for expected in [
            "Session transcripts",
            "Archived transcripts",
            "Cache",
            "Temporary files",
            "Generated images",
            "Plugins",
            "Logs",
            "Databases (SQLite)",
            "Database backups",
            "Everything else",
        ] {
            assert!(labels.contains(&expected), "missing label {expected}");
        }
    }

    #[test]
    fn the_real_opencode_directories_are_labelled_components() {
        let root = temp_root("opencode-components");
        for name in ["storage", "log", "snapshot", "shell", "tool-output"] {
            fs::create_dir(root.join(name)).expect("creates component");
            fs::write(root.join(name).join("f.bin"), vec![0u8; 1]).expect("fills component");
        }

        let report = tool_storage(
            "opencode",
            &PathEnv {
                opencode_data: Some(root),
                ..PathEnv::default()
            },
        );
        let StorageReport::Measured { rows, .. } = report else {
            panic!("expected a measured report");
        };
        let labels: Vec<&str> = rows.iter().map(|row| row.label.as_str()).collect();
        for expected in [
            "Session storage",
            "Logs",
            "Project snapshots (git)",
            "Shell histories",
            "Spilled tool output",
            "Everything else",
        ] {
            assert!(labels.contains(&expected), "missing label {expected}");
        }
    }

    #[test]
    fn a_relocated_sqlite_home_is_reported_outside_the_root_total() {
        let root = temp_root("codex-relocated");
        fs::write(root.join("history.jsonl"), vec![0u8; 10]).expect("writes history");
        let sqlite_home = temp_root("codex-sqlite-home");
        fs::write(sqlite_home.join("state.sqlite"), vec![0u8; 400]).expect("writes db");
        fs::create_dir(sqlite_home.join("db-backups")).expect("creates backups");
        fs::write(sqlite_home.join("db-backups").join("b.bin"), vec![0u8; 50])
            .expect("fills backups");

        let report = tool_storage(
            "codex",
            &PathEnv {
                codex_home: Some(root),
                codex_sqlite_home: Some(sqlite_home),
                ..PathEnv::default()
            },
        );
        let StorageReport::Measured {
            total_bytes,
            rows,
            external_rows,
            ..
        } = report
        else {
            panic!("expected a measured report");
        };
        assert_eq!(total_bytes, 10, "the total describes the root only");
        let internal: Vec<&str> = rows.iter().map(|row| row.label.as_str()).collect();
        assert!(!internal.contains(&"Databases (SQLite)"));
        assert_eq!(external_rows.len(), 2);
        assert!(external_rows[0].path.contains("state.sqlite"));
        assert_eq!(external_rows[0].bytes, 400);
        assert!(external_rows[1].label.contains("Database backups"));
        assert_eq!(external_rows[1].bytes, 50);
    }

    #[test]
    fn an_opencode_db_relocation_is_reported_outside_the_root_total() {
        let root = temp_root("opencode-relocated");
        fs::write(root.join("history.jsonl"), vec![0u8; 10]).expect("writes history");
        let database = temp_root("opencode-db").join("moved.db");
        fs::write(&database, vec![0u8; 700]).expect("writes db");
        fs::write(format!("{}-wal", database.display()), vec![0u8; 30]).expect("writes wal");

        let report = tool_storage(
            "opencode",
            &PathEnv {
                opencode_data: Some(root),
                opencode_db: Some(database),
                ..PathEnv::default()
            },
        );
        let StorageReport::Measured {
            total_bytes,
            external_rows,
            ..
        } = report
        else {
            panic!("expected a measured report");
        };
        assert_eq!(total_bytes, 10, "the total describes the root only");
        assert_eq!(external_rows.len(), 1);
        assert_eq!(external_rows[0].bytes, 730);
        assert!(external_rows[0].path.contains("moved.db"));
        assert!(external_rows[0].path.contains("moved.db-wal"));
    }

    #[test]
    fn a_relocation_pointing_back_at_the_root_is_not_one() {
        let root = temp_root("codex-same-home");
        fs::write(root.join("state.sqlite"), vec![0u8; 40]).expect("writes db");

        let report = tool_storage(
            "codex",
            &PathEnv {
                codex_home: Some(root.clone()),
                codex_sqlite_home: Some(root),
                ..PathEnv::default()
            },
        );
        let StorageReport::Measured {
            rows,
            external_rows,
            ..
        } = report
        else {
            panic!("expected a measured report");
        };
        assert!(external_rows.is_empty());
        let internal: Vec<&str> = rows.iter().map(|row| row.label.as_str()).collect();
        assert!(internal.contains(&"Databases (SQLite)"));
    }

    #[test]
    fn the_report_lists_only_the_tool_groups_in_order() {
        let root = temp_root("report");
        fs::write(root.join("settings.json"), vec![0u8; 3]).expect("writes settings");
        let insights = build_report(
            &[process(10, "agentgauge", None), process(11, "codex", None)],
            &PathEnv {
                codex_home: Some(root.join("codex-home-absent")),
                ..PathEnv::default()
            },
            PortScan::Checked {
                listening: Vec::new(),
            },
            None,
            1_700_000_000_000,
        );
        let ids: Vec<&str> = insights.groups.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, ["codex", "opencode"]);
        assert_eq!(insights.fetched_at, 1_700_000_000_000);
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
            None,
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
                ..PathEnv::default()
            },
            PortScan::Checked {
                listening: Vec::new(),
            },
            None,
            0,
        );
        assert_eq!(insights.groups[0].total_memory_bytes, 400);
        assert_eq!(insights.groups[0].processes.len(), 2);
    }

    #[test]
    fn rows_are_ordered_by_memory_heaviest_first() {
        let mut light = process(10, "codex", Some("/usr/local/bin/codex"));
        light.memory_bytes = 100;
        light.started_at = 1;
        let mut heavy = RawProcess {
            parent_pid: None,
            ..process(11, "codex", Some("/usr/local/bin/codex"))
        };
        heavy.memory_bytes = 900;
        heavy.started_at = 2_000_000_000;

        let insights = build_report(
            &[light, heavy],
            &PathEnv::default(),
            PortScan::Checked {
                listening: Vec::new(),
            },
            None,
            0,
        );
        let pids: Vec<u32> = insights.groups[0]
            .processes
            .iter()
            .map(|process| process.pid)
            .collect();
        assert_eq!(pids, [11, 10]);
    }

    #[test]
    fn cpu_usage_sums_into_the_group_total_and_absence_stays_absent() {
        let mut a = process(10, "codex", Some("/usr/local/bin/codex"));
        a.cpu_usage = Some(12.5);
        let mut b = RawProcess {
            parent_pid: None,
            ..process(11, "codex", Some("/usr/local/bin/codex"))
        };
        b.cpu_usage = Some(2.5);

        let insights = build_report(
            &[a, b],
            &PathEnv::default(),
            PortScan::Checked {
                listening: Vec::new(),
            },
            None,
            0,
        );
        let codex = &insights.groups[0];
        assert_eq!(codex.total_cpu_usage, Some(15.0));
        assert_eq!(codex.processes[0].cpu_usage, Some(12.5));

        let none_reported = build_report(
            &[process(12, "codex", None)],
            &PathEnv::default(),
            PortScan::Checked {
                listening: Vec::new(),
            },
            None,
            0,
        );
        assert_eq!(none_reported.groups[0].total_cpu_usage, None);
    }

    #[test]
    fn a_service_attaches_only_to_a_live_opencode_pid() {
        let server = process(5309, "opencode", Some("/opt/homebrew/bin/opencode"));
        let service = ServiceInfo {
            version: Some("2.0.27".to_owned()),
            url: Some("http://127.0.0.1:49374".to_owned()),
            pid: Some(5309),
        };

        let insights = build_report(
            &[server],
            &PathEnv::default(),
            PortScan::Checked {
                listening: Vec::new(),
            },
            Some(service.clone()),
            0,
        );
        let opencode = insights
            .groups
            .iter()
            .find(|g| g.id == "opencode")
            .expect("group");
        assert_eq!(opencode.service, Some(service));
        assert!(insights.groups[0].service.is_none(), "codex has no service");

        let stale = ServiceInfo {
            version: Some("2.0.27".to_owned()),
            url: Some("http://127.0.0.1:49374".to_owned()),
            pid: Some(99),
        };
        let insights = build_report(
            &[process(5309, "opencode", None)],
            &PathEnv::default(),
            PortScan::Checked {
                listening: Vec::new(),
            },
            Some(stale),
            0,
        );
        let opencode = insights
            .groups
            .iter()
            .find(|g| g.id == "opencode")
            .expect("group");
        assert_eq!(opencode.service, None);
    }

    #[test]
    fn parse_service_reads_only_the_public_facts() {
        let text = r#"{
            "id": "abc",
            "version": "2.0.27",
            "url": "http://127.0.0.1:49374",
            "pid": 12966,
            "password": "a-secret-that-must-never-leave-this-file"
        }"#;
        let service = parse_service(text).expect("parses");
        assert_eq!(service.version.as_deref(), Some("2.0.27"));
        assert_eq!(service.url.as_deref(), Some("http://127.0.0.1:49374"));
        assert_eq!(service.pid, Some(12966));
        let serialized = serde_json::to_string(&service).expect("serializes");
        assert!(!serialized.contains("password"));
        assert!(!serialized.contains("a-secret"));

        assert!(parse_service("not json").is_none());
        assert!(parse_service("{}").is_some());
    }

    #[test]
    fn abnormal_status_tags_only_the_abnormal_states() {
        assert_eq!(
            abnormal_status(sysinfo::ProcessStatus::Stop),
            Some("stopped".to_owned())
        );
        assert_eq!(
            abnormal_status(sysinfo::ProcessStatus::Zombie),
            Some("zombie".to_owned())
        );
        assert_eq!(abnormal_status(sysinfo::ProcessStatus::Run), None);
        assert_eq!(abnormal_status(sysinfo::ProcessStatus::Sleep), None);
    }

    #[test]
    fn a_long_command_is_capped_visibly_and_an_empty_one_is_absent() {
        let long: Vec<String> = vec!["argument".to_owned(); 100];
        let capped = display_command(&long).expect("capped");
        assert!(capped.chars().count() <= MAX_COMMAND_CHARS);
        assert!(capped.ends_with('…'), "the cut must be visible as a cut");
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
            cpu_usage: Some(3.5),
            status: None,
            listening_ports: Vec::new(),
        };
        let value = serde_json::to_value(&summary).expect("serializes");
        assert_eq!(value["startedAt"], 1_700_000_000);
        assert_eq!(value["memoryBytes"], 2048);
        assert_eq!(value["cpuUsage"], 3.5);

        let checked = serde_json::to_value(PortScan::Checked {
            listening: vec![ProcessPort {
                pid: 12966,
                port: 49374,
                address: Some("127.0.0.1".into()),
            }],
        })
        .expect("serializes");
        assert_eq!(checked["state"], "checked");
        assert_eq!(checked["listening"][0]["pid"], 12966);
        assert_eq!(checked["listening"][0]["port"], 49374);
        assert_eq!(checked["listening"][0]["address"], "127.0.0.1");

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
            external_rows: Vec::new(),
        })
        .expect("serializes");
        assert_eq!(measured["state"], "measured");
        assert_eq!(measured["totalBytes"], 10);
        assert!(measured["externalRows"]
            .as_array()
            .expect("external rows are always present on the wire")
            .is_empty());

        let group = serde_json::to_value(ProcessGroup {
            id: "opencode".into(),
            display_name: "OpenCode".into(),
            processes: Vec::new(),
            total_memory_bytes: 0,
            total_cpu_usage: Some(4.0),
            storage: StorageReport::Absent {
                reason: "none".into(),
            },
            ports: PortScan::Checked {
                listening: Vec::new(),
            },
            service: Some(ServiceInfo {
                version: Some("2.0.27".into()),
                url: Some("http://127.0.0.1:49374".into()),
                pid: Some(5309),
            }),
        })
        .expect("serializes");
        assert_eq!(group["totalCpuUsage"], 4.0);
        assert_eq!(group["service"]["version"], "2.0.27");
    }

    #[test]
    fn lsof_field_output_parses_into_pid_port_pairs_with_interfaces() {
        let raw = "p12966\ncopencode\nf7\nn127.0.0.1:49374\np12964\ncopencode\nf12\nn[::1]:4096\np12970\ncopencode\nf9\nn*:4096\n";
        assert_eq!(
            parse_lsof_ports(raw),
            vec![
                ProcessPort {
                    pid: 12966,
                    port: 49374,
                    address: Some("127.0.0.1".into()),
                },
                ProcessPort {
                    pid: 12964,
                    port: 4096,
                    address: Some("::1".into()),
                },
                ProcessPort {
                    pid: 12970,
                    port: 4096,
                    address: Some("*".into()),
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
        assert_eq!(parse_lsof_ports("p12966\nn*:*\n"), Vec::new());
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
                        address: Some("127.0.0.1".into()),
                    },
                    ProcessPort {
                        pid: 12966,
                        port: 49374,
                        address: Some("127.0.0.1".into()),
                    },
                ],
            },
            None,
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
            None,
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
            Some(PathBuf::from("/custom/sqlite")),
            Some(PathBuf::from("/custom/data")),
            Some(PathBuf::from("/custom/moved.db")),
        );
        assert_eq!(paths.codex_home, Some(PathBuf::from("/custom/codex")));
        assert_eq!(
            paths.codex_sqlite_home,
            Some(PathBuf::from("/custom/sqlite"))
        );
        assert_eq!(
            paths.opencode_data,
            Some(PathBuf::from("/custom/data/opencode"))
        );
        assert_eq!(paths.opencode_db, Some(PathBuf::from("/custom/moved.db")));

        let defaults = paths_for(Some(home), None, None, None, None);
        assert_eq!(
            defaults.codex_home,
            Some(PathBuf::from("/tmp/fake-home/.codex"))
        );
        assert_eq!(defaults.codex_sqlite_home, None);
        assert_eq!(
            defaults.opencode_data,
            Some(PathBuf::from("/tmp/fake-home/.local/share/opencode"))
        );
    }

    #[test]
    fn without_a_home_no_storage_root_is_known() {
        let paths = paths_for(None, None, None, None, None);
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
