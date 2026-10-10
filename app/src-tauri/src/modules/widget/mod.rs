//! The macOS system widget: a WidgetKit extension, not a floating window.
//!
//! ## Why there is no window here
//!
//! The first version of this feature was a frameless, always-on-top Tauri
//! window. That is not a system widget: it floats over whatever the user is
//! working in, has to be positioned by us, and cannot be placed in the menu
//! bar, Notification Center, or the desktop by the system. On macOS the correct
//! mechanism is a WidgetKit app extension embedded in the bundle at
//! `Contents/PlugIns/AIStatsWidget.appex`, which the user places and the system
//! renders and schedules. The Swift side lives in `src-tauri/widget/`.
//!
//! ## How the two processes share data
//!
//! The widget runs in a separate process managed by `chronod`, so it cannot read
//! the app's memory. The host app writes a small JSON snapshot to a path both
//! can reach — `~/Library/Application Support/AI Sub Stats/widget-snapshot.json`
//! — and the widget's `TimelineProvider` reads it.
//!
//! An App Group would be the production answer, but it has to be registered on
//! the developer portal first; this build is ad-hoc signed, so a group container
//! is not available. Both processes run as the same user and the extension is
//! not sandboxed, so the file path works without it.
//!
//! ## What this module deliberately does not do
//!
//! It does not claim to know whether the user has placed the widget. macOS
//! exposes no API for that: there is no supported way for a host app to ask
//! "is my widget currently on the user's desktop?". So `extension_present` means
//! the extension is inside this bundle, which is a fact — not a claim about the
//! user's desktop.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::shared::domain::{Freshness, UsageSnapshot};
use crate::shared::error::Error;

/// Bundle name of the extension. Must match `SCHEME` in `widget/build-widget.sh`.
pub const WIDGET_EXTENSION_NAME: &str = "AIStatsWidget.appex";

/// Bumped when the snapshot shape changes.
///
/// The widget refuses to render a snapshot whose version it does not recognise,
/// so a mismatch shows as "no reading" rather than as numbers that may no longer
/// mean what they claim.
pub const SNAPSHOT_VERSION: u32 = 1;

/// Desktop widgets require macOS 14. Below that only Notification Center widgets
/// existed, and `chronod` will not load a modern widget extension.
pub const MINIMUM_MACOS_MAJOR: u32 = 14;
pub const MINIMUM_MACOS_VERSION: &str = "14.0";

/// The directory the snapshot is written to, relative to `$HOME`.
///
/// Must stay in step with `SnapshotStore.relativePath` in
/// `widget/Sources/SnapshotStore.swift`.
pub const SNAPSHOT_RELATIVE_PATH: &str =
    "Library/Application Support/AI Sub Stats/widget-snapshot.json";

// ---------------------------------------------------------------------------
// Snapshot: the wire contract with the Swift side
// ---------------------------------------------------------------------------

/// Which usage window a row describes.
///
/// Sent explicitly rather than derived from the display label. The app's labels
/// are short and provider-derived (`"5h"`, `"weekly"`), and asking Swift to
/// pattern-match on them would make a cosmetic label change silently break the
/// widget's ability to tell a 5-hour countdown from a weekly one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowKind {
    FiveHour,
    Weekly,
    Other,
}

/// One window as the widget renders it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetWindow {
    pub kind: WindowKind,
    /// The app's own label, for display.
    pub label: String,
    /// Percentage still available, already clamped to 0..=100.
    pub remaining_percent: i32,
    /// Unix seconds, or `None` when the provider reported no reset time.
    pub resets_at: Option<i64>,
}

/// Everything the widget renders.
///
/// An unavailable reading is a value with a `reason`, not an absence — the widget
/// shows the reason rather than an empty frame that could be misread as "you have
/// plenty left".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetSnapshot {
    pub version: u32,
    /// Unix seconds at which this snapshot was written.
    pub generated_at: i64,
    pub plan: Option<String>,
    pub freshness: Freshness,
    /// Present when `freshness` is [`Freshness::Unavailable`].
    pub reason: Option<String>,
    pub windows: Vec<WidgetWindow>,
}

impl WidgetSnapshot {
    /// Projects a usage snapshot into the shape the widget reads.
    ///
    /// Windows are mapped by identity — the app already knows which one is the
    /// 5-hour window and which is weekly — rather than by label.
    pub fn from_usage(snapshot: &UsageSnapshot, now_secs: i64) -> Self {
        let mut windows = Vec::new();

        if let Some(five_hour) = snapshot.five_hour.as_ref() {
            windows.push(WidgetWindow {
                kind: WindowKind::FiveHour,
                label: five_hour.label.clone(),
                remaining_percent: five_hour.remaining_percent.clamp(0, 100),
                resets_at: five_hour.resets_at,
            });
        }
        if let Some(weekly) = snapshot.weekly.as_ref() {
            windows.push(WidgetWindow {
                kind: WindowKind::Weekly,
                label: weekly.label.clone(),
                remaining_percent: weekly.remaining_percent.clamp(0, 100),
                resets_at: weekly.resets_at,
            });
        }
        // Any window the provider reported that is neither of the two we name
        // explicitly is still worth showing, but must not be mislabelled.
        for window in &snapshot.windows {
            let is_named = windows
                .iter()
                .any(|w| w.label == window.label && w.resets_at == window.resets_at);
            if !is_named {
                windows.push(WidgetWindow {
                    kind: WindowKind::Other,
                    label: window.label.clone(),
                    remaining_percent: window.remaining_percent.clamp(0, 100),
                    resets_at: window.resets_at,
                });
            }
        }

        Self {
            version: SNAPSHOT_VERSION,
            generated_at: now_secs,
            plan: snapshot.plan.as_ref().map(|p| format!("{p:?}")),
            freshness: snapshot.freshness,
            reason: snapshot.reason.clone(),
            windows,
        }
    }

    /// A snapshot recording that no reading was possible.
    pub fn unavailable(reason: impl Into<String>, now_secs: i64) -> Self {
        Self {
            version: SNAPSHOT_VERSION,
            generated_at: now_secs,
            plan: None,
            freshness: Freshness::Unavailable,
            reason: Some(reason.into()),
            windows: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Writing the snapshot
// ---------------------------------------------------------------------------

/// Writes the snapshot to the path both processes can read.
///
/// Held in Tauri state; owns no `AppHandle`, so it is unit-testable against a
/// temporary directory.
#[derive(Debug, Clone)]
pub struct SnapshotStore {
    path: PathBuf,
}

impl SnapshotStore {
    /// Resolves the store from `$HOME`.
    ///
    /// `None` when `HOME` is unset, which is the honest answer: without a home
    /// directory there is nowhere the widget could read from either.
    pub fn from_env() -> Option<Self> {
        let home = std::env::var_os("HOME")?;
        Some(Self {
            path: Path::new(&home).join(SNAPSHOT_RELATIVE_PATH),
        })
    }

    /// Builds a store at an explicit path. For tests.
    #[cfg(test)]
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Writes the snapshot atomically.
    ///
    /// The widget may read this file at any moment, including mid-poll, so the
    /// snapshot is written to a sibling temp file and renamed over the target.
    /// A plain `write` would let a reader observe a truncated file and render
    /// garbage — or, worse, treat a partial read as "no data".
    pub fn write(&self, snapshot: &WidgetSnapshot) -> Result<(), Error> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                Error::storage(format!("could not create {}: {e}", parent.display()))
            })?;
        }

        let json = serde_json::to_vec_pretty(snapshot)
            .map_err(|e| Error::invalid_payload(format!("snapshot would not serialise: {e}")))?;

        let temp = self.path.with_extension("json.tmp");
        fs::write(&temp, &json)
            .map_err(|e| Error::storage(format!("could not write {}: {e}", temp.display())))?;
        fs::rename(&temp, &self.path).map_err(|e| {
            // Clean up so a failed write does not leave a stale temp file that a
            // later successful write would trip over.
            let _ = fs::remove_file(&temp);
            Error::storage(format!("could not publish {}: {e}", self.path.display()))
        })?;

        Ok(())
    }

    /// Whether a snapshot has ever been published for the widget to read.
    ///
    /// `false` means the widget will render its "open the app" placeholder, so
    /// the setup guide can say that before the user goes looking for a widget
    /// that would show nothing.
    pub fn has_snapshot(&self) -> bool {
        self.path.is_file()
    }
}

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Status: what the setup guide needs to know
// ---------------------------------------------------------------------------

/// One step of the system's own widget setup procedure.
///
/// The steps are specific to the running macOS release because the procedure
/// genuinely differs: on macOS 26+ a widget can also be added to the menu bar,
/// which did not exist before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStep {
    pub title: String,
    pub detail: String,
}

/// The system widget system for the current platform.
///
/// Serialised as a plain string so the client can render it without an enum
/// round-trip.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WidgetSystem {
    /// macOS WidgetKit.
    WidgetKit,
    /// No system widget mechanism is implemented for this platform yet.
    None,
}

/// Everything the setup guide renders.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemWidgetStatus {
    /// Whether a system widget can be used on this machine at all.
    pub supported: bool,
    pub system: WidgetSystem,
    /// The running macOS release, when the platform is macOS.
    pub os_version: Option<String>,
    pub minimum_version: String,
    /// Whether this build ships the extension source.
    pub extension_bundled: bool,
    /// Whether the extension is present inside the running bundle.
    ///
    /// `false` during `tauri dev`, which runs the raw binary with no `.app`
    /// around it. That is a fact about the build, not a failure.
    pub extension_present: bool,
    /// Whether a snapshot has been published for the widget to read.
    pub snapshot_written: bool,
    /// Whether the widget can also live in the menu bar (macOS 26+).
    pub menu_bar_available: bool,
    /// The procedure, empty when there is nothing to do.
    pub setup: Vec<SetupStep>,
    /// Why the widget is unavailable. Present only when `supported` is false.
    pub reason: Option<String>,
}

impl SystemWidgetStatus {
    /// Detects the status of a specific build.
    ///
    /// Every input is injected so this is testable without a Mac, a bundle, or a
    /// home directory.
    pub fn detect(
        platform: &str,
        os_version: Option<&str>,
        extension_present: bool,
        snapshot_written: bool,
    ) -> Self {
        let is_macos = platform.eq_ignore_ascii_case("macos");
        let os = os_version.and_then(parse_version);
        let major = os.map(|(major, _)| major);

        let supported = is_macos && major.is_some_and(|m| m >= MINIMUM_MACOS_MAJOR);

        let mut reason = None;
        if !is_macos {
            reason = Some(
                "The system widget is implemented for macOS only. This build has no equivalent \
                 for your platform yet."
                    .to_string(),
            );
        } else if major.is_none() {
            reason = Some("Could not determine the macOS version.".to_string());
        } else if !supported {
            reason = Some(format!(
                "Desktop widgets need macOS {MINIMUM_MACOS_VERSION} or newer."
            ));
        }

        let menu_bar_available = major.is_some_and(|m| m >= 26);

        let setup = if supported {
            setup_steps(extension_present, snapshot_written, menu_bar_available)
        } else {
            Vec::new()
        };

        Self {
            supported,
            system: if is_macos {
                WidgetSystem::WidgetKit
            } else {
                WidgetSystem::None
            },
            os_version: os_version.map(str::to_string),
            minimum_version: MINIMUM_MACOS_VERSION.to_string(),
            extension_bundled: true,
            extension_present,
            snapshot_written,
            menu_bar_available,
            setup,
            reason,
        }
    }

    /// Detects the status for the running build.
    pub fn current() -> Self {
        let store = SnapshotStore::from_env();
        Self::detect(
            std::env::consts::OS,
            macos_version().as_deref(),
            extension_is_embedded(),
            store.is_some_and(|s| s.has_snapshot()),
        )
    }
}

/// The setup procedure, worded to match what macOS actually shows.
fn setup_steps(extension_present: bool, snapshot_written: bool, menu_bar: bool) -> Vec<SetupStep> {
    let mut steps = Vec::new();

    if !extension_present {
        steps.push(SetupStep {
            title: "Run the packaged app, not the dev server".to_string(),
            detail: format!(
                "This build does not contain the widget extension. Run `bun run tauri build` and \
                 open {} — the extension is embedded automatically.",
                "AgentGauge.app"
            ),
        });
        return steps;
    }

    steps.push(SetupStep {
        title: "Open the widget gallery".to_string(),
        detail: "Right-click the desktop and choose Edit Widgets. Notification Center works too: \
                 click the clock, then Add Widgets."
            .to_string(),
    });
    steps.push(SetupStep {
        title: "Find AgentGauge".to_string(),
        detail: "Search for “AgentGauge” in the gallery.".to_string(),
    });
    steps.push(SetupStep {
        title: "Choose a size and drag it in".to_string(),
        detail: if menu_bar {
            "Small, Medium and Large all show the 5-hour window and the weekly limit. On macOS 26 \
             or newer you can also add it to the menu bar from Control Center settings."
                .to_string()
        } else {
            "Small, Medium and Large all show the 5-hour window and the weekly limit.".to_string()
        },
    });

    if !snapshot_written {
        steps.push(SetupStep {
            title: "Refresh the reading".to_string(),
            detail: "The widget is showing its placeholder because no usage reading has been \
                     published yet. Open the app and refresh usage, then wait for the next widget \
                     refresh."
                .to_string(),
        });
    }

    steps
}

// ---------------------------------------------------------------------------
// Probing the host machine
// ---------------------------------------------------------------------------

/// The macOS product version, e.g. `("27", "0")` on macOS 27.0.
///
/// Read through `sw_vers` rather than `uname`, whose Darwin kernel version does
/// not map cleanly onto the marketing release — and guessing that mapping wrong
/// would produce a wrong minimum-version verdict.
pub fn macos_version() -> Option<String> {
    let output = Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8(output.stdout).ok()?;
    let version = version.trim();
    if version.is_empty() {
        return None;
    }
    Some(version.to_string())
}

/// Parses `"14.0"` into `(14, 0)`.
///
/// Only the first two numeric components are considered, so a build suffix like
/// `"27.0.1"` does not fail to parse.
pub fn parse_version(version: &str) -> Option<(u32, u32)> {
    let mut parts = version.trim().split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts
        .next()
        .and_then(|p| p.parse::<u32>().ok())
        .unwrap_or(0);
    Some((major, minor))
}

/// The `.app` root for a running executable.
///
/// A bundled executable lives at `<App>.app/Contents/MacOS/<name>`, so the root is
/// two levels up. `None` for an unbundled binary, which is what `tauri dev`
/// runs.
pub fn bundle_root(exe: &Path) -> Option<PathBuf> {
    let macos_dir = exe.parent()?;
    if macos_dir.file_name()? != "MacOS" {
        return None;
    }
    let contents = macos_dir.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    let root = contents.parent()?;
    if root.extension()?.to_str()? != "app" {
        return None;
    }
    Some(root.to_path_buf())
}

/// Whether the widget extension is inside the bundle of the running binary.
pub fn extension_is_embedded() -> bool {
    std::env::current_exe()
        .ok()
        .as_deref()
        .and_then(bundle_root)
        .is_some_and(|root| {
            root.join("Contents")
                .join("PlugIns")
                .join(WIDGET_EXTENSION_NAME)
                .exists()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("agentgauge-widget-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn usage_with_both_windows() -> UsageSnapshot {
        use crate::shared::domain::{PlanKind, UsagePermission, UsageWindow};
        let five_hour = UsageWindow::new("5h", 12, Some(300), Some(1_700_000_000 + 17_760));
        let weekly = UsageWindow::new("weekly", 54, Some(10_080), Some(1_700_000_000 + 345_600));
        UsageSnapshot {
            provider: crate::shared::domain::ProviderKind::Codex,
            freshness: Freshness::Live,
            fetched_at: Some(1_700_000_000),
            source: "codex app-server".to_string(),
            reason: None,
            plan: Some(PlanKind::Team),
            permission: UsagePermission::Allowed,
            windows: vec![five_hour.clone(), weekly.clone()],
            five_hour: Some(five_hour),
            weekly: Some(weekly),
        }
    }

    #[test]
    fn a_snapshot_names_each_window_rather_than_asking_the_widget_to_match_labels() {
        // The app's labels are "5h" and "weekly". If the widget had to infer
        // which window was which from that text, a label change would silently
        // swap a 5-hour countdown for a weekly one.
        let snapshot = WidgetSnapshot::from_usage(&usage_with_both_windows(), 1_700_000_000);
        let kinds: Vec<_> = snapshot.windows.iter().map(|w| w.kind).collect();
        assert_eq!(kinds, vec![WindowKind::FiveHour, WindowKind::Weekly]);
    }

    #[test]
    fn a_snapshot_serialises_to_the_shape_the_widget_decodes() {
        let snapshot = WidgetSnapshot::from_usage(&usage_with_both_windows(), 1_700_000_000);
        let json = serde_json::to_value(&snapshot).expect("serialises");

        assert_eq!(json["version"], SNAPSHOT_VERSION);
        assert_eq!(json["generatedAt"], 1_700_000_000);
        assert_eq!(json["freshness"], "live");
        assert_eq!(json["windows"][0]["kind"], "fiveHour");
        assert_eq!(json["windows"][0]["remainingPercent"], 88);
        assert_eq!(json["windows"][1]["kind"], "weekly");
        assert_eq!(json["windows"][1]["remainingPercent"], 46);
    }

    #[test]
    fn an_unavailable_reading_carries_its_reason_and_no_windows() {
        // The widget must show *why*, never an empty frame that reads as healthy.
        let snapshot = WidgetSnapshot::unavailable("codex login required", 1_700_000_000);
        assert_eq!(snapshot.freshness, Freshness::Unavailable);
        assert_eq!(snapshot.reason.as_deref(), Some("codex login required"));
        assert!(snapshot.windows.is_empty());

        let json = serde_json::to_value(&snapshot).expect("serialises");
        assert_eq!(json["reason"], "codex login required");
    }

    #[test]
    fn an_out_of_range_percentage_is_clamped_rather_than_drawn() {
        // A negative bar width is a rendering bug, and >100 would overflow the
        // widget. The clamp happens here so no surface has to remember it.
        let mut usage = usage_with_both_windows();
        usage.five_hour = Some(crate::shared::domain::UsageWindow {
            remaining_percent: -5,
            ..usage.windows[0].clone()
        });
        let snapshot = WidgetSnapshot::from_usage(&usage, 0);
        assert_eq!(snapshot.windows[0].remaining_percent, 0);

        let mut usage = usage_with_both_windows();
        usage.five_hour = Some(crate::shared::domain::UsageWindow {
            remaining_percent: 250,
            ..usage.windows[0].clone()
        });
        let snapshot = WidgetSnapshot::from_usage(&usage, 0);
        assert_eq!(snapshot.windows[0].remaining_percent, 100);
    }

    #[test]
    fn the_widget_never_shows_the_same_window_twice() {
        let snapshot = WidgetSnapshot::from_usage(&usage_with_both_windows(), 0);
        let labels: Vec<_> = snapshot.windows.iter().map(|w| &w.label).collect();
        assert_eq!(labels, vec!["5h", "weekly"]);
    }

    #[test]
    fn a_snapshot_is_published_atomically() {
        let dir = scratch("atomic");
        let store = SnapshotStore::at(dir.join("widget-snapshot.json"));

        store
            .write(&WidgetSnapshot::from_usage(&usage_with_both_windows(), 1))
            .expect("writes");

        assert!(store.has_snapshot());
        // No temp file left behind, and the published one is complete JSON.
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .expect("readable")
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "a .tmp file survived the write");

        let written: serde_json::Value =
            serde_json::from_slice(&fs::read(store.path()).expect("readable")).expect("valid JSON");
        assert_eq!(written["version"], SNAPSHOT_VERSION);
    }

    #[test]
    fn a_store_with_nothing_written_reports_none() {
        let dir = scratch("empty");
        let store = SnapshotStore::at(dir.join("widget-snapshot.json"));
        assert!(!store.has_snapshot());
    }

    #[test]
    fn status_is_unsupported_off_macos() {
        let status = SystemWidgetStatus::detect("linux", Some("6.8.0"), true, true);
        assert!(!status.supported);
        assert_eq!(status.system, WidgetSystem::None);
        assert!(
            status.setup.is_empty(),
            "no steps for an unsupported platform"
        );
        assert!(status.reason.is_some());
    }

    #[test]
    fn status_is_unsupported_below_the_minimum_release() {
        let status = SystemWidgetStatus::detect("macos", Some("13.6"), true, true);
        assert!(!status.supported);
        assert_eq!(status.minimum_version, "14.0");
        assert!(status
            .reason
            .as_deref()
            .is_some_and(|r| r.contains("macOS 14.0")));
    }

    #[test]
    fn an_undetectable_os_version_is_not_treated_as_supported() {
        // "We could not tell" must not read as "yes it works".
        let status = SystemWidgetStatus::detect("macos", None, true, true);
        assert!(!status.supported);
        assert!(status.reason.is_some());
    }

    #[test]
    fn a_supported_release_gets_the_procedure() {
        let status = SystemWidgetStatus::detect("macos", Some("15.3"), true, true);
        assert!(status.supported);
        assert_eq!(status.system, WidgetSystem::WidgetKit);
        assert!(!status.menu_bar_available, "menu bar widgets are macOS 26+");
        assert!(status.setup.len() >= 3);
        assert!(
            status.setup.iter().any(|s| s.detail.contains("5-hour")),
            "the guide should name the windows the widget shows"
        );
    }

    #[test]
    fn the_menu_bar_is_offered_only_from_macos_26() {
        assert!(SystemWidgetStatus::detect("macos", Some("26.0"), true, true).menu_bar_available);
        assert!(!SystemWidgetStatus::detect("macos", Some("25.9"), true, true).menu_bar_available);
    }

    #[test]
    fn a_build_without_the_extension_says_so_instead_of_guiding_a_hunt() {
        let status = SystemWidgetStatus::detect("macos", Some("15.3"), false, false);
        assert!(status.supported);
        assert!(!status.extension_present);
        assert_eq!(status.setup.len(), 1);
        assert!(status.setup[0].title.contains("packaged app"));
    }

    #[test]
    fn a_missing_snapshot_is_explained_rather_than_left_blank() {
        // The widget renders its placeholder until a reading exists, so the guide
        // should say that before the user goes looking for a broken widget.
        let status = SystemWidgetStatus::detect("macos", Some("15.3"), true, false);
        assert!(!status.snapshot_written);
        assert!(status
            .setup
            .iter()
            .any(|s| s.detail.to_lowercase().contains("placeholder")));
    }

    #[test]
    fn a_complete_build_needs_no_snapshot_step() {
        let status = SystemWidgetStatus::detect("macos", Some("15.3"), true, true);
        assert!(status.snapshot_written);
        assert!(!status.setup.iter().any(|s| s.title.contains("Refresh")));
    }

    #[test]
    fn versions_parse_without_being_fooled_by_a_build_suffix() {
        assert_eq!(parse_version("14.0"), Some((14, 0)));
        assert_eq!(parse_version("27.0.1"), Some((27, 0)));
        assert_eq!(parse_version("26"), Some((26, 0)));
        assert_eq!(parse_version("beta"), None);
    }

    #[test]
    fn a_bundled_executable_is_recognised_and_a_dev_binary_is_not() {
        let bundled = Path::new("/Applications/AgentGauge.app/Contents/MacOS/agentgauge-daemon");
        assert_eq!(
            bundle_root(bundled),
            Some(PathBuf::from("/Applications/AgentGauge.app"))
        );

        // `tauri dev` runs the raw binary with no bundle around it.
        let unbundled = Path::new("/repo/target/debug/agentgauge-daemon");
        assert_eq!(bundle_root(unbundled), None);
    }
}
