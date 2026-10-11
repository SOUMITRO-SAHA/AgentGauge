//! Read-only process and storage insights for the agent toolchain.
//!
//! One bounded capability: a snapshot of what AgentGauge, Codex and OpenCode
//! are doing to this machine — running processes with their memory and age,
//! and the on-disk footprint each one owns. Everything here is a read; there
//! is deliberately no capability to stop, signal, or delete anything.
//!
//! [`RawProcess`] is the provider-agnostic process record. The matching and
//! grouping functions over it are pure and unit-tested; the `sysinfo` adapter
//! is a thin translation at the edge so the logic can be exercised without a
//! live process table. Storage is measured with a plain filesystem walk —
//! logical file sizes, symlinks not followed — and an unreadable subtree
//! contributes nothing rather than failing the whole read.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::shared::legacy_shared;

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
    pub agentgauge_data: Option<PathBuf>,
    pub legacy_shared: Option<PathBuf>,
    pub codex_home: Option<PathBuf>,
    pub opencode_data: Option<PathBuf>,
}

/// The executables tracked as tool groups beside the app itself.
const TRACKED_TOOLS: [(&str, &str); 2] = [("codex", "Codex"), ("opencode", "OpenCode")];

/// The widget extension's executable, so the app group counts the process
/// that renders the system widget even when it runs outside the app bundle.
const WIDGET_EXECUTABLE: &str = "aistatswidget";

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

/// Whether a process is a root of the AgentGauge group: this very process,
/// any `agentgauge` binary (the desktop app, the kickoff worker, an e2e
/// build), or the widget extension.
fn is_agentgauge_root(process: &RawProcess, self_pid: u32) -> bool {
    if process.pid == self_pid {
        return true;
    }
    if process
        .exe
        .as_deref()
        .is_some_and(|exe| normalized_stem(exe).contains("agentgauge"))
    {
        return true;
    }
    let name = normalized_stem(&process.name);
    name.contains("agentgauge") || name == WIDGET_EXECUTABLE
}

/// Selects the AgentGauge group: its roots plus every descendant, minus the
/// processes that belong to a tracked tool (a provider process the app
/// spawned is the tool's cost, not the app's).
pub fn select_agentgauge(processes: &[RawProcess], self_pid: u32) -> Vec<RawProcess> {
    let mut selected: Vec<bool> = processes
        .iter()
        .map(|process| is_agentgauge_root(process, self_pid))
        .collect();

    loop {
        let selected_pids: std::collections::HashSet<u32> = processes
            .iter()
            .enumerate()
            .filter(|(index, _)| selected[*index])
            .map(|(_, process)| process.pid)
            .collect();

        let mut changed = false;
        for (index, process) in processes.iter().enumerate() {
            if selected[index] {
                continue;
            }
            let parent_selected = process
                .parent_pid
                .is_some_and(|parent| selected_pids.contains(&parent));
            let belongs_to_a_tool = TRACKED_TOOLS
                .iter()
                .any(|(executable, _)| matches_tool(process, executable));
            if parent_selected && !belongs_to_a_tool {
                selected[index] = true;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    processes
        .iter()
        .enumerate()
        .filter(|(index, _)| selected[*index])
        .map(|(_, process)| process.clone())
        .collect()
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

/// Measures a footprint from a root and labelled components inside it.
///
/// `total` always describes the whole root; each component that exists
/// becomes a row, and one arithmetic "everything else" row closes the gap so
/// the rows always sum to the total.
fn measure_storage(root: &Path, components: &[(&str, &str)]) -> StorageReport {
    let Ok(total) = walk_size(root) else {
        return StorageReport::Absent {
            reason: format!("`{}` does not exist or cannot be read.", root.display()),
        };
    };

    let mut rows = Vec::new();
    let mut component_bytes = 0;
    let mut component_files = 0;
    for (label, name) in components {
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

/// The app's own footprint: every root it writes, measured and summed.
///
/// Unlike a tool's single home, the app owns two directories — its private
/// app data and the legacy shared directory the widget and kickoff worker
/// read — so each measured root is a row and the total spans them.
///
/// When nothing could be measured, the reason distinguishes the two ways
/// that happens: roots that do not exist (nothing written yet) from roots
/// that exist but could not be read. A permission failure must not render
/// as "never wrote anything".
fn agentgauge_storage(paths: &PathEnv) -> StorageReport {
    let mut rows = Vec::new();
    let mut total = Walked::default();
    let mut any_unreadable = false;

    for (label, root) in [
        ("App data", paths.agentgauge_data.as_deref()),
        ("Widget & schedule data", paths.legacy_shared.as_deref()),
    ] {
        let Some(root) = root else { continue };
        if let Ok(walked) = walk_size(root) {
            total.bytes += walked.bytes;
            total.file_count += walked.file_count;
            rows.push(StorageRow {
                label: label.to_owned(),
                path: root.display().to_string(),
                bytes: walked.bytes,
                file_count: walked.file_count,
            });
        } else if root.exists() {
            any_unreadable = true;
        }
    }

    if rows.is_empty() {
        return StorageReport::Absent {
            reason: if any_unreadable {
                "AgentGauge's data directories exist but could not be read.".to_owned()
            } else {
                "AgentGauge has not written any data yet.".to_owned()
            },
        };
    }

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
                ("Session transcripts", "sessions"),
                ("Archived transcripts", "archived_sessions"),
            ]
            .as_slice(),
        ),
        "opencode" => (
            "OpenCode",
            paths.opencode_data.as_deref(),
            [("Session storage", "storage"), ("Logs", "log")].as_slice(),
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

/// Builds the whole read from a process snapshot and resolved roots.
pub fn build_report(
    processes: &[RawProcess],
    paths: &PathEnv,
    self_pid: u32,
    now_ms: u64,
) -> ProcessInsights {
    let mut groups = Vec::with_capacity(TRACKED_TOOLS.len() + 1);

    let mut app_processes = select_agentgauge(processes, self_pid);
    app_processes.sort_by_key(|process| process.started_at);
    groups.push(ProcessGroup {
        id: "agentgauge".to_owned(),
        display_name: "AgentGauge".to_owned(),
        total_memory_bytes: app_processes
            .iter()
            .map(|process| process.memory_bytes)
            .sum(),
        processes: app_processes.iter().map(summarize).collect(),
        storage: agentgauge_storage(paths),
    });

    for (executable, display_name) in TRACKED_TOOLS {
        let mut selected = select_tool(processes, executable);
        selected.sort_by_key(|process| process.started_at);
        groups.push(ProcessGroup {
            id: executable.to_owned(),
            display_name: display_name.to_owned(),
            total_memory_bytes: selected.iter().map(|process| process.memory_bytes).sum(),
            processes: selected.iter().map(summarize).collect(),
            storage: tool_storage(executable, paths),
        });
    }

    ProcessInsights {
        fetched_at: now_ms,
        groups,
    }
}

/// One process summarized for the wire.
fn summarize(process: &RawProcess) -> ProcessSummary {
    ProcessSummary {
        pid: process.pid,
        name: process.name.clone(),
        command: display_command(&process.cmd),
        started_at: Some(process.started_at),
        memory_bytes: Some(process.memory_bytes),
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

/// Resolves the storage roots from the environment and the app's own data
/// directory, which the composition root hands in.
pub fn resolve_paths(home: Option<PathBuf>, app_data: Option<PathBuf>) -> PathEnv {
    let codex_home = std::env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let xdg_data = std::env::var_os("XDG_DATA_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    paths_for(home, app_data, codex_home, xdg_data)
}

/// The pure root-resolution rule, with the environment already read.
fn paths_for(
    home: Option<PathBuf>,
    app_data: Option<PathBuf>,
    codex_home: Option<PathBuf>,
    xdg_data: Option<PathBuf>,
) -> PathEnv {
    let Some(home) = home else {
        return PathEnv {
            agentgauge_data: app_data,
            ..PathEnv::default()
        };
    };

    PathEnv {
        agentgauge_data: app_data,
        legacy_shared: Some(legacy_shared::legacy_dir(&home.clone().into_os_string())),
        codex_home: Some(codex_home.unwrap_or_else(|| home.join(".codex"))),
        opencode_data: Some(
            xdg_data
                .unwrap_or_else(|| home.join(".local").join("share"))
                .join("opencode"),
        ),
    }
}

/// The capability behind the `processInsights` request.
pub fn read_insights(app_data: Option<PathBuf>) -> ProcessInsights {
    let home = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let now = crate::shared::clock::Clock::now_ms(&crate::shared::clock::SystemClock);
    build_report(
        &snapshot_processes(),
        &resolve_paths(home, app_data),
        std::process::id(),
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

    // --- the app group ---------------------------------------------------

    #[test]
    fn the_app_group_always_contains_the_current_process() {
        let all = [process(10, "agentgauge", None), process(11, "codex", None)];
        let selected = select_agentgauge(&all, 10);
        assert_eq!(selected.iter().map(|p| p.pid).collect::<Vec<_>>(), [10]);
    }

    #[test]
    fn agentgauge_binaries_beyond_this_process_are_roots() {
        let all = [process(12, "agentgauge", Some("/usr/local/bin/agentgauge"))];
        let selected = select_agentgauge(&all, 1);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].pid, 12);
    }

    #[test]
    fn the_widget_extension_belongs_to_the_app_group() {
        let widget = process(
            13,
            "AIStatsWidget",
            Some("/Applications/AgentGauge.app/Contents/PlugIns/AIStatsWidget.appex/Contents/MacOS/AIStatsWidget"),
        );
        assert!(is_agentgauge_root(&widget, 1));
    }

    #[test]
    fn descendants_join_the_app_group_transitively() {
        let webcontent = RawProcess {
            parent_pid: Some(10),
            ..process(14, "com.apple.WebKit.WebContent", None)
        };
        let grandchild = RawProcess {
            parent_pid: Some(14),
            ..process(15, "com.apple.WebKit.Networking", None)
        };
        let me = process(10, "agentgauge", None);
        let selected = select_agentgauge(&[me, webcontent, grandchild], 10);
        let mut pids: Vec<u32> = selected.iter().map(|p| p.pid).collect();
        pids.sort_unstable();
        assert_eq!(pids, [10, 14, 15]);
    }

    #[test]
    fn a_spawned_tool_process_is_the_tools_cost_not_the_apps() {
        let me = process(10, "agentgauge", None);
        let server = RawProcess {
            parent_pid: Some(10),
            ..process(16, "codex", Some("/usr/local/bin/codex"))
        };
        let all = [me, server];
        assert_eq!(
            select_agentgauge(&all, 10)
                .iter()
                .map(|p| p.pid)
                .collect::<Vec<_>>(),
            [10]
        );
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

        let report = measure_storage(&root, &[("Sessions", "sessions")]);
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
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].label, "Sessions");
        assert_eq!(rows[0].bytes, 90);
        assert_eq!(rows[1].label, "Everything else");
        assert_eq!(rows[1].bytes, 10);
    }

    #[test]
    fn an_absent_root_is_reported_absent_with_a_reason() {
        let report = measure_storage(
            &std::env::temp_dir().join("agentgauge-never-exists"),
            &[("Sessions", "sessions")],
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

    #[cfg(unix)]
    #[test]
    fn an_unreadable_app_root_is_not_claimed_as_never_written() {
        use std::os::unix::fs::PermissionsExt;

        let root = temp_root("unreadable-app");
        fs::write(root.join("settings.json"), vec![0u8; 2]).expect("writes settings");
        let mut permissions = fs::metadata(&root).expect("reads metadata").permissions();
        permissions.set_mode(0o000);
        fs::set_permissions(&root, permissions).expect("locks the root");

        let report = agentgauge_storage(&PathEnv {
            agentgauge_data: Some(root.clone()),
            ..PathEnv::default()
        });

        let mut permissions = fs::metadata(&root).expect("reads metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&root, permissions).expect("unlocks the root");

        let StorageReport::Absent { reason } = report else {
            panic!("expected an absent report for an unreadable root");
        };
        assert!(reason.contains("could not be read"));
        assert!(!reason.contains("not written"));
    }

    #[test]
    fn a_missing_component_is_omitted_rather_than_listed_as_zero() {
        let root = temp_root("partial");
        fs::write(root.join("history.jsonl"), vec![0u8; 5]).expect("writes history");
        let report = measure_storage(&root, &[("Sessions", "sessions")]);
        let StorageReport::Measured { rows, .. } = report else {
            panic!("expected a measured report");
        };
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "Everything else");
    }

    // --- the report ------------------------------------------------------

    #[test]
    fn the_report_lists_the_app_then_the_tools_in_order() {
        let root = temp_root("report");
        fs::write(root.join("settings.json"), vec![0u8; 3]).expect("writes settings");
        let insights = build_report(
            &[process(10, "agentgauge", None), process(11, "codex", None)],
            &PathEnv {
                agentgauge_data: Some(root.clone()),
                legacy_shared: None,
                codex_home: Some(root.join("codex-home-absent")),
                opencode_data: None,
            },
            10,
            1_700_000_000_000,
        );
        let ids: Vec<&str> = insights.groups.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, ["agentgauge", "codex", "opencode"]);
        assert_eq!(insights.fetched_at, 1_700_000_000_000);
    }

    #[test]
    fn a_group_with_no_processes_is_an_explicit_empty_list() {
        let root = temp_root("empty");
        let insights = build_report(
            &[],
            &PathEnv {
                agentgauge_data: Some(root.clone()),
                legacy_shared: None,
                codex_home: None,
                opencode_data: None,
            },
            10,
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
        let mut a = process(10, "agentgauge", None);
        a.memory_bytes = 300;
        let mut b = RawProcess {
            parent_pid: Some(10),
            ..process(11, "WebContent", None)
        };
        b.memory_bytes = 100;
        let insights = build_report(
            &[a, b],
            &PathEnv {
                agentgauge_data: Some(root),
                legacy_shared: None,
                codex_home: None,
                opencode_data: None,
            },
            10,
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
        };
        let value = serde_json::to_value(&summary).expect("serializes");
        assert_eq!(value["startedAt"], 1_700_000_000);
        assert_eq!(value["memoryBytes"], 2048);

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

    #[test]
    fn roots_resolve_from_home_with_overrides_honoured() {
        let home = PathBuf::from("/tmp/fake-home");
        let paths = paths_for(
            Some(home.clone()),
            Some(PathBuf::from("/app-data")),
            Some(PathBuf::from("/custom/codex")),
            Some(PathBuf::from("/custom/data")),
        );
        assert_eq!(paths.codex_home, Some(PathBuf::from("/custom/codex")));
        assert_eq!(
            paths.opencode_data,
            Some(PathBuf::from("/custom/data/opencode"))
        );
        assert_eq!(
            paths.legacy_shared,
            Some(home.join(legacy_shared::LEGACY_RELATIVE_DIR))
        );

        let defaults = paths_for(Some(home), None, None, None);
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
        let paths = paths_for(None, Some(PathBuf::from("/app-data")), None, None);
        assert!(paths.codex_home.is_none());
        assert!(paths.opencode_data.is_none());
        assert!(paths.legacy_shared.is_none());
        assert_eq!(paths.agentgauge_data, Some(PathBuf::from("/app-data")));
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
    fn a_live_read_places_this_process_in_the_app_group() {
        let insights = read_insights(None);
        assert_eq!(insights.groups.len(), TRACKED_TOOLS.len() + 1);
        let app = insights.groups.first().expect("the app group comes first");
        assert_eq!(app.id, "agentgauge");
        assert!(
            app.processes.iter().any(|p| p.pid == std::process::id()),
            "the reading must contain the process that asked for it"
        );
    }
}
