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
//! can reach — `~/Library/Application Support/AgentGauge/widget-snapshot.json`
//! — and the widget's `TimelineProvider` reads it.
//!
//! An App Group requires developer-team provisioning. Until one is configured,
//! the sandboxed extension uses scoped home-relative file exceptions to read
//! and write AgentGauge data and read the legacy folder for migration.
//!
//! ## Configuration status
//!
//! `WidgetCenter.getCurrentConfigurations` reports configured widget kinds. It
//! must be called from the app's own process — a spawned helper executable is
//! rejected by `chronod` — so the bundled Swift bridge dylib
//! (`Contents/Frameworks/libWidgetBridge.dylib`) is loaded with `dlopen` and
//! answers in-process. `extension_present` remains a separate bundle fact; the
//! optional `configured` field is populated only when that query succeeds. The
//! same bridge carries `reloadAllTimelines` after each snapshot publication.
//!
//! That query answers about this app alone — chronod keys configurations per
//! containing app — so a sibling build's widget is invisible to it. The widget
//! extension therefore records a placement receipt every time WidgetKit renders
//! it outside the gallery, and [`placement`] reads every receipt so this app can
//! tell that an AgentGauge widget is on the Mac even when it belongs to another
//! build. `placed_kinds` is the union of the two: kinds WidgetCenter reported
//! for this app, plus kinds with a fresh receipt.

mod placement;
mod refresh;

pub use placement::PlacementReceiptStore;
pub use refresh::process_pending as process_widget_refresh;

use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::shared::bundle::bundle_root;
use crate::shared::domain::{Freshness, ProviderKind, UsageSnapshot, UsageWindow};
use crate::shared::error::Error;
use crate::shared::platform::macos_version;

/// Bundle name of the extension. Must match `SCHEME` in `widget/build-widget.sh`.
pub const WIDGET_EXTENSION_NAME: &str = "AIStatsWidget.appex";
#[cfg(debug_assertions)]
pub const WIDGET_KIND: &str = "AIStatsUsageWidgetDev";
#[cfg(not(debug_assertions))]
pub const WIDGET_KIND: &str = "AIStatsUsageWidget";

/// Bumped when the snapshot shape changes.
///
/// The widget refuses to render a snapshot whose version it does not recognise,
/// so a mismatch shows as "no reading" rather than as numbers that may no longer
/// mean what they claim.
pub const SNAPSHOT_VERSION: u32 = 2;

/// Desktop widgets require macOS 14. Below that only Notification Center widgets
/// existed, and `chronod` will not load a modern widget extension.
pub const MINIMUM_MACOS_MAJOR: u32 = 14;
pub const MINIMUM_MACOS_VERSION: &str = "14.0";

/// The release snapshot file's name inside AgentGauge's application-support directory.
///
/// The directory itself is the shared contract in `shared::app_support`.
/// The joined path must stay in step with `SnapshotStore.relativePath` in
/// `widget/Sources/SnapshotStore.swift`.
pub const SNAPSHOT_FILE_NAME: &str = "widget-snapshot.json";

static SNAPSHOT_PUBLISH_LOCK: Mutex<()> = Mutex::new(());
static SNAPSHOT_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(target_os = "macos")]
struct SnapshotPublishFileLock(fs::File);

#[cfg(target_os = "macos")]
impl SnapshotPublishFileLock {
    fn acquire(snapshot_path: &std::path::Path) -> Result<Self, Error> {
        use std::os::fd::AsRawFd;

        let lock_path = snapshot_path.with_extension("lock");
        if let Some(parent) = lock_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                Error::storage(format!("could not create widget lock directory: {error}"))
            })?;
        }
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|error| {
                Error::storage(format!("could not open widget publish lock: {error}"))
            })?;
        // SAFETY: The descriptor stays owned by this guard until its Drop unlocks it.
        if unsafe { flock(file.as_raw_fd(), 2) } != 0 {
            return Err(Error::storage(format!(
                "could not lock widget snapshot: {}",
                std::io::Error::last_os_error()
            )));
        }
        Ok(Self(file))
    }
}

#[cfg(target_os = "macos")]
impl Drop for SnapshotPublishFileLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;

        // SAFETY: This guard owns the still-open descriptor and unlocks it once.
        let _ = unsafe { flock(self.0.as_raw_fd(), 8) };
    }
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn flock(fd: i32, operation: i32) -> i32;
}

// ---------------------------------------------------------------------------
// Snapshot: the wire contract with the Swift side
// ---------------------------------------------------------------------------

/// One quota row as the widget renders it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetQuota {
    /// Percentage still available, already clamped to 0..=100.
    pub remaining_percent: i32,
    /// Unix seconds, or `None` when the provider reported no reset time.
    pub resets_at: Option<i64>,
}

impl From<&UsageWindow> for WidgetQuota {
    fn from(window: &UsageWindow) -> Self {
        Self {
            remaining_percent: window.remaining_percent.clamp(0, 100),
            resets_at: window.resets_at,
        }
    }
}

/// One provider's 5-hour and weekly quotas.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetProviderSnapshot {
    pub provider: ProviderKind,
    pub display_name: String,
    pub generated_at: i64,
    pub plan: Option<String>,
    pub freshness: Freshness,
    pub reason: Option<String>,
    pub five_hour: Option<WidgetQuota>,
    pub weekly: Option<WidgetQuota>,
}

impl WidgetProviderSnapshot {
    fn from_usage(snapshot: &UsageSnapshot, now_secs: i64) -> Self {
        Self {
            provider: snapshot.provider,
            display_name: snapshot.provider.display_name().to_string(),
            generated_at: snapshot
                .fetched_at
                .map_or(now_secs, |ms| ms.div_euclid(1000)),
            plan: snapshot.plan.as_ref().map(|p| format!("{p:?}")),
            freshness: snapshot.freshness,
            reason: snapshot.reason.clone(),
            five_hour: snapshot.five_hour.as_ref().map(WidgetQuota::from),
            weekly: snapshot.weekly.as_ref().map(WidgetQuota::from),
        }
    }

    fn has_quotas(&self) -> bool {
        self.five_hour.is_some() || self.weekly.is_some()
    }

    fn unavailable(provider: ProviderKind, reason: impl Into<String>, now_secs: i64) -> Self {
        Self {
            provider,
            display_name: provider.display_name().to_string(),
            generated_at: now_secs,
            plan: None,
            freshness: Freshness::Unavailable,
            reason: Some(reason.into()),
            five_hour: None,
            weekly: None,
        }
    }
}

/// The complete widget payload. It contains only the quota windows the widget
/// promises to show, and only for providers that have a current or cached read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetSnapshot {
    pub version: u32,
    pub providers: Vec<WidgetProviderSnapshot>,
}

impl WidgetSnapshot {
    #[cfg(test)]
    pub fn from_usage(snapshot: &UsageSnapshot, now_secs: i64) -> Self {
        Self::merge(None, std::slice::from_ref(snapshot), now_secs)
    }

    pub fn merge(previous: Option<Self>, updates: &[UsageSnapshot], now_secs: i64) -> Self {
        let mut providers = previous.map_or_else(Vec::new, |snapshot| snapshot.providers);

        for update in updates {
            let updated = WidgetProviderSnapshot::from_usage(update, now_secs);
            if update.freshness == Freshness::Unavailable && !updated.has_quotas() {
                if let Some(previous) = providers
                    .iter_mut()
                    .find(|provider| provider.provider == update.provider && provider.has_quotas())
                {
                    previous.freshness = Freshness::Stale;
                }
                continue;
            }

            if let Some(previous) = providers
                .iter_mut()
                .find(|provider| provider.provider == update.provider)
            {
                *previous = updated;
            } else {
                providers.push(updated);
            }
        }

        providers.retain(|provider| provider.has_quotas());
        providers.sort_by_key(|provider| match provider.provider {
            ProviderKind::Codex => 0,
            ProviderKind::Zai => 1,
            ProviderKind::Minimax => 2,
            ProviderKind::Kimi => 3,
        });

        if providers.is_empty() {
            let fallback_provider = updates
                .first()
                .map(|snapshot| snapshot.provider)
                .unwrap_or(ProviderKind::Codex);
            let fallback_reason = updates
                .first()
                .and_then(|snapshot| snapshot.reason.as_deref())
                .unwrap_or("Open AgentGauge to read usage.");
            providers.push(WidgetProviderSnapshot::unavailable(
                fallback_provider,
                fallback_reason,
                now_secs,
            ));
        }

        Self {
            version: SNAPSHOT_VERSION,
            providers,
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
        #[cfg(debug_assertions)]
        if let Some(dir) = std::env::var_os("AGENTGAUGE_DATA_DIR") {
            return Some(Self {
                path: PathBuf::from(dir).join("widget-snapshot-dev.json"),
            });
        }
        let filename = if cfg!(debug_assertions) {
            "widget-snapshot-dev.json"
        } else {
            SNAPSHOT_FILE_NAME
        };
        let current = crate::shared::app_support::app_support_dir(&home).join(filename);
        let previous = crate::shared::app_support::previous_app_support_dir(&home).join(filename);
        if let Err(error) = crate::shared::app_support::migrate_file(&previous, &current) {
            log::warn!("could not migrate the previous widget snapshot: {error}");
            if !current.exists() && previous.is_file() {
                return Some(Self { path: previous });
            }
        }
        Some(Self { path: current })
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

    pub fn read(&self) -> Result<Option<WidgetSnapshot>, Error> {
        let data = match fs::read(&self.path) {
            Ok(data) => data,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(Error::storage(format!(
                    "could not read {}: {error}",
                    self.path.display()
                )))
            }
        };
        let value: serde_json::Value = serde_json::from_slice(&data).map_err(|error| {
            Error::storage(format!("could not decode {}: {error}", self.path.display()))
        })?;
        match value.get("version").and_then(serde_json::Value::as_u64) {
            Some(1) => {
                let legacy: LegacyWidgetSnapshotV1 =
                    serde_json::from_value(value).map_err(|error| {
                        Error::storage(format!("could not decode {}: {error}", self.path.display()))
                    })?;
                Ok(Some(legacy.into_current()))
            }
            Some(version) if version == u64::from(SNAPSHOT_VERSION) => {
                let snapshot: WidgetSnapshot = serde_json::from_value(value).map_err(|error| {
                    Error::storage(format!("could not decode {}: {error}", self.path.display()))
                })?;
                Ok(Some(snapshot))
            }
            _ => Ok(None),
        }
    }

    pub fn publish(&self, updates: &[UsageSnapshot], now_secs: i64) -> Result<(), Error> {
        let _guard = SNAPSHOT_PUBLISH_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        #[cfg(target_os = "macos")]
        let _file_guard = SnapshotPublishFileLock::acquire(&self.path)?;
        let previous = match self.read() {
            Ok(snapshot) => snapshot,
            Err(error) => {
                log::warn!("could not read previous widget snapshot: {}", error.message);
                None
            }
        };
        self.write(&WidgetSnapshot::merge(previous, updates, now_secs))
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

        let (temp, mut file) = loop {
            let sequence = SNAPSHOT_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let temp = self
                .path
                .with_extension(format!("json.{}.{sequence}.tmp", std::process::id()));
            match OpenOptions::new().write(true).create_new(true).open(&temp) {
                Ok(file) => break (temp, file),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(Error::storage(format!(
                        "could not create {}: {error}",
                        temp.display()
                    )))
                }
            }
        };
        if let Err(error) = file.write_all(&json) {
            let _ = fs::remove_file(&temp);
            return Err(Error::storage(format!(
                "could not write {}: {error}",
                temp.display()
            )));
        }
        drop(file);
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyWidgetSnapshotV1 {
    generated_at: i64,
    plan: Option<String>,
    freshness: Freshness,
    reason: Option<String>,
    windows: Vec<LegacyWidgetWindowV1>,
}

impl LegacyWidgetSnapshotV1 {
    fn into_current(self) -> WidgetSnapshot {
        let mut provider = WidgetProviderSnapshot {
            provider: ProviderKind::Codex,
            display_name: ProviderKind::Codex.display_name().to_string(),
            generated_at: self.generated_at,
            plan: self.plan,
            freshness: self.freshness,
            reason: self.reason,
            five_hour: None,
            weekly: None,
        };

        for window in self.windows {
            let quota = WidgetQuota {
                remaining_percent: window.remaining_percent.clamp(0, 100),
                resets_at: window.resets_at,
            };
            match window.kind {
                LegacyWidgetWindowKindV1::FiveHour => provider.five_hour = Some(quota),
                LegacyWidgetWindowKindV1::Weekly => provider.weekly = Some(quota),
                LegacyWidgetWindowKindV1::Other => {}
            }
        }

        WidgetSnapshot {
            version: SNAPSHOT_VERSION,
            providers: vec![provider],
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyWidgetWindowV1 {
    kind: LegacyWidgetWindowKindV1,
    remaining_percent: i32,
    resets_at: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum LegacyWidgetWindowKindV1 {
    FiveHour,
    Weekly,
    Other,
}

#[cfg(test)]
fn snapshot_path(home: &std::ffi::OsString, development: bool) -> PathBuf {
    let filename = if development {
        "widget-snapshot-dev.json"
    } else {
        SNAPSHOT_FILE_NAME
    };
    crate::shared::app_support::app_support_dir(home).join(filename)
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
    /// Whether WidgetKit reports a user-configured instance of this build's
    /// widget.
    ///
    /// `None` means the system query was unavailable; it is never treated as
    /// an answer that the widget is not configured.
    pub configured: Option<bool>,
    /// Every AgentGauge widget kind placed on this Mac.
    ///
    /// This build's own answer from WidgetCenter, plus the kinds a sibling
    /// build's widget left a fresh placement receipt for — receipts for this
    /// build's own kind are dropped once the query has answered, because
    /// WidgetCenter reports a removal immediately and the receipt outlives it by
    /// the whole freshness window. This is what the setup action keys off: a
    /// widget the user can see on screen must not be reported as needing setup,
    /// and a widget they removed must not keep the action away.
    pub placed_kinds: Vec<String>,
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
            configured: None,
            placed_kinds: Vec::new(),
            menu_bar_available,
            setup,
            reason,
        }
    }

    /// Detects the status for the running build.
    pub fn current() -> Self {
        let store = SnapshotStore::from_env();
        let extension_present = extension_is_embedded();
        let mut status = Self::detect(
            std::env::consts::OS,
            macos_version().as_deref(),
            extension_present,
            store.is_some_and(|s| s.has_snapshot()),
        );
        let mut configured_kinds = Vec::new();
        if status.supported && extension_present {
            if let Some(answer) = widget_configuration_status() {
                status.configured = answer.configured;
                configured_kinds = answer.kinds;
            }
        } else {
            log::debug!(
                "widget configuration not queried: supported={} extension_present={}",
                status.supported,
                extension_present
            );
        }
        status.placed_kinds = placed_kinds(status.configured, &configured_kinds);
        status
    }
}

/// Every AgentGauge widget kind placed on this Mac.
///
/// Receipts are read whatever the query did: an unbundled build cannot ask
/// WidgetKit, and a sibling build's placed widget is exactly the case receipts
/// exist for.
fn placed_kinds(configured: Option<bool>, configured_kinds: &[String]) -> Vec<String> {
    let receipts = PlacementReceiptStore::from_env()
        .map(|store| store.placed_kinds(unix_seconds()))
        .unwrap_or_default();
    merge_placed_kinds(
        configured_kinds,
        &trustworthy_receipt_kinds(configured, &receipts),
    )
}

/// The receipt kinds worth reading alongside WidgetCenter's own answer.
///
/// WidgetCenter answers for this build's kind live: a user who removes the
/// widget is reflected within one poll, while the receipt their last render left
/// stays fresh for [`RECEIPT_MAX_AGE_SECS`]. Trusting it would keep the setup
/// action hidden for the whole window after a removal, so once the query has
/// answered, a receipt about this build's own kind describes a placement that
/// may already be gone. When the query could not run there is nothing
/// authoritative to defer to, and a receipt is the only evidence available —
/// including for this build's own kind.
fn trustworthy_receipt_kinds(configured: Option<bool>, receipt_kinds: &[String]) -> Vec<String> {
    match configured {
        Some(_) => receipt_kinds
            .iter()
            .filter(|kind| *kind != WIDGET_KIND)
            .cloned()
            .collect(),
        None => receipt_kinds.to_vec(),
    }
}

/// Unions the two sources of a placement, keeping WidgetCenter's order first.
///
/// Deduplicated because both sources can name this build's own kind: a widget
/// that is configured has both a configuration and, once WidgetKit renders it, a
/// receipt.
fn merge_placed_kinds(configured_kinds: &[String], receipt_kinds: &[String]) -> Vec<String> {
    let mut kinds: Vec<String> = configured_kinds.to_vec();
    for kind in receipt_kinds {
        if !kinds.contains(kind) {
            kinds.push(kind.clone());
        }
    }
    kinds
}

/// Seconds since the Unix epoch, or `0` when the clock is before it.
fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs() as i64)
        .unwrap_or_default()
}

/// The setup procedure, worded to match what macOS actually shows.
fn setup_steps(extension_present: bool, snapshot_written: bool, menu_bar: bool) -> Vec<SetupStep> {
    let mut steps = Vec::new();

    if !extension_present {
        steps.push(SetupStep {
            title: "Open the packaged app, not the dev server".to_string(),
            detail: format!(
                "This executable has no app bundle around it, so it carries no widget \
                 extension and cannot detect one. Run `bun run build:mac` in `app/` and open \
                 {} — the build embeds the widget extension into the app.",
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WidgetConfigurationResponse {
    configured: Option<bool>,
    #[serde(default)]
    configured_kinds: Vec<String>,
}

#[derive(Debug, PartialEq)]
struct WidgetConfiguration {
    configured: Option<bool>,
    kinds: Vec<String>,
}

fn decode_widget_configuration(stdout: &[u8], success: bool) -> Option<WidgetConfiguration> {
    if !success {
        return None;
    }
    serde_json::from_slice::<WidgetConfigurationResponse>(stdout)
        .ok()
        .map(|response| WidgetConfiguration {
            configured: response.configured,
            kinds: response.configured_kinds,
        })
}

/// Name of the Swift bridge dylib embedded at `Contents/Frameworks/`.
///
/// Must stay in step with `BRIDGE_NAME` in `widget/build-widget.sh` and the
/// `@_cdecl` symbols in `widget/Sources/WidgetBridge.swift`.
const WIDGET_BRIDGE_NAME: &str = "libWidgetBridge.dylib";

/// `WidgetCenter` must be called from the app's own process: `chronod` accepts
/// the calls only from the executable the bundle's `CFBundleExecutable` names,
/// so a spawned helper is rejected and configuration would stay unknown
/// forever. The bridge is a dylib precisely so it runs in-process.
#[cfg(target_os = "macos")]
mod bridge {
    use std::ffi::{c_char, c_int, c_void, CString};
    use std::path::PathBuf;

    use crate::shared::bundle::bundle_root;

    use super::WIDGET_BRIDGE_NAME;

    const RTLD_NOW: c_int = 0x2;
    const RTLD_LOCAL: c_int = 0x4;

    extern "C" {
        fn dlopen(filename: *const c_char, flags: c_int) -> *mut c_void;
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }

    struct Handle(*mut c_void);

    // SAFETY: the handle is an opaque `dlopen` pointer. `dlopen`, `dlsym` and
    // the bridge's own `@_cdecl` entry points are safe to call from any thread
    // — each call carries everything it needs and the bridge serialises its own
    // reply — so the raw pointer is only ever read, never shared mutably.
    unsafe impl Send for Handle {}
    unsafe impl Sync for Handle {}

    /// Opened once, then kept for the lifetime of the process — and never closed.
    ///
    /// The status is re-read on a timer while the app is visible, so opening per
    /// read would `dlopen`/`dlclose` the same image every few seconds. Unloading
    /// is the riskier half of that pair: WidgetKit code the bridge links can
    /// still be reachable while a reply is in flight, and unmapping an image
    /// underneath it is a crash rather than a failed query. Keeping the handle
    /// is what makes the poll cheap as well.
    static BRIDGE: std::sync::OnceLock<LoadedBridge> = std::sync::OnceLock::new();

    /// The bridge and, when it did not load, why — the reason a user needs when
    /// detection silently cannot run.
    struct LoadedBridge {
        handle: Option<Handle>,
        reason: String,
    }

    impl LoadedBridge {
        fn load() -> Self {
            let Some(path) = path() else {
                return Self {
                    handle: None,
                    reason: format!(
                        "this executable is not inside an app bundle, so {} is unreachable",
                        WIDGET_BRIDGE_NAME
                    ),
                };
            };
            let path_text = path.to_string_lossy().into_owned();
            let Ok(raw) = CString::new(path.into_os_string().as_encoded_bytes()) else {
                return Self {
                    handle: None,
                    reason: format!("the bundle path {path_text} is not valid C text"),
                };
            };
            let handle = unsafe { dlopen(raw.as_ptr(), RTLD_NOW | RTLD_LOCAL) };
            if handle.is_null() {
                return Self {
                    handle: None,
                    reason: format!("{path_text} could not be loaded into this process"),
                };
            }
            Self {
                handle: Some(Handle(handle)),
                reason: String::new(),
            }
        }
    }

    /// The bridge's answer, or the reason it could not be loaded.
    fn open() -> Result<&'static Handle, &'static str> {
        let bridge = BRIDGE.get_or_init(LoadedBridge::load);
        bridge.handle.as_ref().ok_or(bridge.reason.as_str())
    }

    /// Where the bridge lives inside this bundle.
    ///
    /// `None` for an unbundled executable — `tauri dev` and the e2e harness both
    /// run the bare binary — which is a fact about the build, not a failure to
    /// load.
    pub fn path() -> Option<PathBuf> {
        let root = std::env::current_exe()
            .ok()
            .as_deref()
            .and_then(bundle_root)?;
        Some(
            root.join("Contents")
                .join("Frameworks")
                .join(WIDGET_BRIDGE_NAME),
        )
    }

    fn symbol<'a>(handle: &'a Handle, name: &str) -> Option<*mut c_void> {
        let name = CString::new(name).ok()?;
        let symbol = unsafe { dlsym(handle.0, name.as_ptr()) };
        if symbol.is_null() {
            return None;
        }
        Some(symbol)
    }

    /// The bridge's answer for `kind`, read fresh every time.
    ///
    /// Every failure is unknown, never "not configured": a missing bundle, an
    /// unloadable bridge, a truncated reply, or a query WidgetKit never answers
    /// all mean the same thing to the user — the app cannot tell — and saying
    /// otherwise would send them into a gallery they already used.
    pub fn configured_status(kind: &str) -> Option<super::WidgetConfiguration> {
        type StatusFn =
            unsafe extern "C" fn(kind: *const c_char, out: *mut c_char, capacity: c_int) -> c_int;

        let handle = match open() {
            Ok(handle) => handle,
            Err(reason) => {
                log::warn!("widget status unknown: {reason}");
                return None;
            }
        };
        let status = match symbol(handle, "agentgauge_widget_status") {
            Some(status) => status,
            None => {
                log::warn!(
                    "widget status unknown: {} exports no agentgauge_widget_status",
                    WIDGET_BRIDGE_NAME
                );
                return None;
            }
        };
        let status: StatusFn = unsafe { std::mem::transmute(status) };
        let kind = CString::new(kind).ok()?;
        let mut buffer = [0u8; 256];
        let written = unsafe {
            status(
                kind.as_ptr(),
                buffer.as_mut_ptr().cast::<c_char>(),
                buffer.len() as c_int,
            )
        };
        if written <= 0 || written as usize >= buffer.len() {
            log::warn!(
                "widget status unknown: the bridge wrote {written} byte(s) of {}",
                buffer.len()
            );
            return None;
        }
        let json = String::from_utf8(buffer[..written as usize].to_vec()).ok()?;
        let answer = super::decode_widget_configuration(json.as_bytes(), true);
        if answer.is_none() {
            log::warn!("widget status unknown: unreadable reply from the bridge");
        }
        answer
    }

    /// Whether the reload request was accepted for delivery to WidgetKit.
    pub fn request_reload() -> bool {
        type ReloadFn = unsafe extern "C" fn() -> bool;

        let Ok(handle) = open() else {
            return false;
        };
        let Some(reload) = symbol(handle, "agentgauge_widget_reload") else {
            return false;
        };
        let reload: ReloadFn = unsafe { std::mem::transmute(reload) };
        unsafe { reload() }
    }
}

#[cfg(target_os = "macos")]
fn widget_configuration_status() -> Option<WidgetConfiguration> {
    let answer = bridge::configured_status(WIDGET_KIND);
    log::debug!(
        "widget configuration read: configured={:?} kinds={:?}",
        answer.as_ref().and_then(|answer| answer.configured),
        answer.as_ref().map(|answer| &answer.kinds),
    );
    answer
}

#[cfg(not(target_os = "macos"))]
fn widget_configuration_status() -> Option<WidgetConfiguration> {
    None
}

/// Asks WidgetKit to re-read the snapshot after the app republished it.
///
/// A rejection is logged, never propagated: the widget also refreshes on its
/// own schedule, so a failed nudge degrades to the system cadence.
pub fn request_timeline_reload() {
    #[cfg(target_os = "macos")]
    if !bridge::request_reload() {
        log::warn!(
            "WidgetKit did not accept the timeline refresh request; it may update on its schedule"
        );
    }
    #[cfg(not(target_os = "macos"))]
    let () = ();
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

    #[test]
    fn debug_and_release_widget_snapshots_use_separate_files() {
        let home = std::ffi::OsString::from("/Users/dev");
        assert_eq!(
            snapshot_path(&home, true).file_name().unwrap(),
            "widget-snapshot-dev.json"
        );
        assert_eq!(
            snapshot_path(&home, false).file_name().unwrap(),
            SNAPSHOT_FILE_NAME
        );
    }

    fn usage_with_both_windows() -> UsageSnapshot {
        use crate::shared::domain::{PlanKind, UsagePermission, UsageWindow};
        let five_hour = UsageWindow::new("5h", 12, Some(300), Some(1_700_000_000 + 17_760));
        let weekly = UsageWindow::new("weekly", 54, Some(10_080), Some(1_700_000_000 + 345_600));
        UsageSnapshot {
            provider: crate::shared::domain::ProviderKind::Codex,
            freshness: Freshness::Live,
            fetched_at: Some(1_700_000_000_000),
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
    fn a_snapshot_projects_only_the_5_hour_and_weekly_quotas() {
        let snapshot = WidgetSnapshot::from_usage(&usage_with_both_windows(), 1_700_000_000);
        assert_eq!(snapshot.providers[0].provider, ProviderKind::Codex);
        assert_eq!(
            snapshot.providers[0]
                .five_hour
                .as_ref()
                .unwrap()
                .remaining_percent,
            88
        );
        assert_eq!(
            snapshot.providers[0]
                .weekly
                .as_ref()
                .unwrap()
                .remaining_percent,
            46
        );
    }

    #[test]
    fn a_snapshot_serialises_to_the_shape_the_widget_decodes() {
        let snapshot = WidgetSnapshot::from_usage(&usage_with_both_windows(), 1_700_000_000);
        let json = serde_json::to_value(&snapshot).expect("serialises");

        assert_eq!(json["version"], SNAPSHOT_VERSION);
        assert_eq!(json["providers"][0]["provider"], "codex");
        assert_eq!(json["providers"][0]["displayName"], "Codex");
        assert_eq!(json["providers"][0]["generatedAt"], 1_700_000_000);
        assert_eq!(json["providers"][0]["freshness"], "live");
        assert_eq!(json["providers"][0]["fiveHour"]["remainingPercent"], 88);
        assert_eq!(json["providers"][0]["weekly"]["remainingPercent"], 46);
        assert!(json["providers"][0].get("windows").is_none());
    }

    #[test]
    fn a_cached_reading_keeps_the_provider_fetch_time_not_the_widget_publish_time() {
        let mut usage = usage_with_both_windows();
        usage.freshness = Freshness::Cached;
        usage.fetched_at = Some(1_700_000_000_000);

        let snapshot = WidgetSnapshot::from_usage(&usage, 1_700_007_200);

        assert_eq!(snapshot.providers[0].generated_at, 1_700_000_000);
        assert_eq!(snapshot.providers[0].freshness, Freshness::Cached);
    }

    #[test]
    fn an_unavailable_reading_carries_its_reason_and_no_windows() {
        let usage = UsageSnapshot::unavailable(ProviderKind::Codex, "codex login required");
        let snapshot = WidgetSnapshot::from_usage(&usage, 1_700_000_000);
        let provider = &snapshot.providers[0];
        assert_eq!(provider.freshness, Freshness::Unavailable);
        assert_eq!(provider.reason.as_deref(), Some("codex login required"));
        assert!(provider.five_hour.is_none());
        assert!(provider.weekly.is_none());

        let json = serde_json::to_value(&snapshot).expect("serialises");
        assert_eq!(json["providers"][0]["reason"], "codex login required");
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
        assert_eq!(
            snapshot.providers[0]
                .five_hour
                .as_ref()
                .unwrap()
                .remaining_percent,
            0
        );

        let mut usage = usage_with_both_windows();
        usage.five_hour = Some(crate::shared::domain::UsageWindow {
            remaining_percent: 250,
            ..usage.windows[0].clone()
        });
        let snapshot = WidgetSnapshot::from_usage(&usage, 0);
        assert_eq!(
            snapshot.providers[0]
                .five_hour
                .as_ref()
                .unwrap()
                .remaining_percent,
            100
        );
    }

    #[test]
    fn provider_refresh_merges_with_other_readings_and_keeps_old_data_stale_on_failure() {
        let codex = usage_with_both_windows();
        let previous = WidgetSnapshot::from_usage(&codex, 1_700_000_000);
        let mut zai = usage_with_both_windows();
        zai.provider = ProviderKind::Zai;
        zai.source = ProviderKind::Zai.source().to_string();

        let unconnected = UsageSnapshot::unavailable(ProviderKind::Kimi, "not connected");
        let merged = WidgetSnapshot::merge(Some(previous), &[zai, unconnected], 1_700_000_010);
        assert_eq!(
            merged
                .providers
                .iter()
                .map(|p| p.provider)
                .collect::<Vec<_>>(),
            vec![ProviderKind::Codex, ProviderKind::Zai]
        );

        let failed_codex =
            UsageSnapshot::unavailable(ProviderKind::Codex, "temporary read failure");
        let merged = WidgetSnapshot::merge(Some(merged), &[failed_codex], 1_700_000_020);
        assert_eq!(merged.providers[0].freshness, Freshness::Stale);
        assert_eq!(merged.providers[0].generated_at, 1_700_000_000);
        assert_eq!(
            merged.providers[0]
                .five_hour
                .as_ref()
                .unwrap()
                .remaining_percent,
            88
        );
    }

    #[test]
    fn simultaneous_provider_reads_keep_both_widget_quotas() {
        use std::sync::{Arc, Barrier};

        let store = SnapshotStore::at(scratch("parallel-merge").join("widget-snapshot.json"));
        for _ in 0..32 {
            let barrier = Arc::new(Barrier::new(3));
            let mut zai = usage_with_both_windows();
            zai.provider = ProviderKind::Zai;
            std::thread::scope(|scope| {
                for usage in [usage_with_both_windows(), zai] {
                    let store = store.clone();
                    let barrier = barrier.clone();
                    scope.spawn(move || {
                        barrier.wait();
                        store.publish(&[usage], 1_700_000_000).expect("publish");
                    });
                }
                barrier.wait();
            });

            let providers = store
                .read()
                .expect("read")
                .expect("published")
                .providers
                .into_iter()
                .map(|snapshot| snapshot.provider)
                .collect::<Vec<_>>();
            assert_eq!(providers, vec![ProviderKind::Codex, ProviderKind::Zai]);
        }
    }

    #[test]
    fn a_snapshot_is_published_atomically() {
        let dir = scratch("atomic");
        let store = SnapshotStore::at(dir.join("widget-snapshot.json"));
        let snapshot = WidgetSnapshot::from_usage(&usage_with_both_windows(), 1);

        store.write(&snapshot).expect("writes");
        assert_eq!(store.read().expect("reads"), Some(snapshot));

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
    fn a_previous_snapshot_version_migrates_to_codex_quota_fields() {
        let dir = scratch("previous-version");
        let store = SnapshotStore::at(dir.join("widget-snapshot.json"));
        let legacy = serde_json::json!({
            "version": 1,
            "generatedAt": 1_700_000_000,
            "plan": "Team",
            "freshness": "live",
            "reason": null,
            "windows": [
                {"kind": "fiveHour", "label": "5h", "remainingPercent": 88, "resetsAt": 1_700_017_760},
                {"kind": "weekly", "label": "weekly", "remainingPercent": 46, "resetsAt": 1_700_345_600},
                {"kind": "other", "label": "monthly", "remainingPercent": 22, "resetsAt": null}
            ]
        });
        fs::write(store.path(), serde_json::to_vec(&legacy).unwrap()).expect("legacy file");

        let migrated = store.read().expect("reads old version").expect("snapshot");

        assert_eq!(migrated.version, SNAPSHOT_VERSION);
        assert_eq!(migrated.providers.len(), 1);
        assert_eq!(migrated.providers[0].provider, ProviderKind::Codex);
        assert_eq!(
            migrated.providers[0]
                .five_hour
                .as_ref()
                .unwrap()
                .remaining_percent,
            88
        );
        assert_eq!(
            migrated.providers[0]
                .weekly
                .as_ref()
                .unwrap()
                .remaining_percent,
            46
        );
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
        assert_eq!(status.configured, None);
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
    fn a_placement_is_either_the_configured_kinds_or_a_fresh_receipt() {
        // This build's widget: WidgetCenter names it, and the union keeps it once.
        assert_eq!(
            merge_placed_kinds(&[WIDGET_KIND.to_string()], &[WIDGET_KIND.to_string()]),
            vec![WIDGET_KIND.to_string()]
        );

        // The sibling build's widget, which this app's own query cannot see.
        let sibling = if WIDGET_KIND == "AIStatsUsageWidgetDev" {
            "AIStatsUsageWidget"
        } else {
            "AIStatsUsageWidgetDev"
        };
        assert_eq!(
            merge_placed_kinds(&[], &[sibling.to_string(), WIDGET_KIND.to_string()]),
            vec![sibling.to_string(), WIDGET_KIND.to_string()]
        );

        // Nothing placed anywhere.
        assert!(merge_placed_kinds(&[], &[]).is_empty());
    }

    #[test]
    fn a_removed_widget_keeps_no_placement_once_widgetkit_answers() {
        // The removal case: WidgetCenter reports this kind as gone while the
        // extension's last render is still on disk and still inside the
        // freshness window. The query is live and the receipt is not, so the
        // query wins — otherwise the setup action stays hidden for the whole
        // window after the user removed the widget.
        assert_eq!(
            trustworthy_receipt_kinds(Some(false), &[WIDGET_KIND.to_string()]),
            Vec::<String>::new()
        );

        // The same receipt when the query could not run is the only evidence
        // there is, so it still counts — including for this build's own kind.
        assert_eq!(
            trustworthy_receipt_kinds(None, &[WIDGET_KIND.to_string()]),
            vec![WIDGET_KIND.to_string()]
        );
    }

    #[test]
    fn a_sibling_receipt_outranks_the_answer_about_our_own_kind() {
        let sibling = if WIDGET_KIND == "AIStatsUsageWidgetDev" {
            "AIStatsUsageWidget"
        } else {
            "AIStatsUsageWidgetDev"
        };

        // WidgetCenter's answer covers this build's kinds only, so a receipt
        // naming the other build survives whatever it said about ours.
        for configured in [Some(false), Some(true), None] {
            assert_eq!(
                trustworthy_receipt_kinds(configured, &[sibling.to_string()]),
                vec![sibling.to_string()]
            );
        }
    }

    #[test]
    fn widget_center_replies_distinguish_false_from_unknown() {
        let reply = |json: &[u8]| decode_widget_configuration(json, true);
        assert_eq!(
            reply(br#"{"configured":false,"kinds":[]}"#),
            Some(WidgetConfiguration {
                configured: Some(false),
                kinds: vec![]
            })
        );
        assert_eq!(
            reply(br#"{"configured":false,"configuredKinds":["AIStatsUsageWidgetDev"]}"#),
            Some(WidgetConfiguration {
                configured: Some(false),
                kinds: vec!["AIStatsUsageWidgetDev".to_string()]
            })
        );
        assert_eq!(
            reply(br#"{"configured":true,"configuredKinds":["AIStatsUsageWidget"]}"#),
            Some(WidgetConfiguration {
                configured: Some(true),
                kinds: vec!["AIStatsUsageWidget".to_string()]
            })
        );
        assert_eq!(
            reply(br#"{"configured":null,"configuredKinds":[]}"#),
            Some(WidgetConfiguration {
                configured: None,
                kinds: vec![]
            }),
            "a null answer means the query ran but reported unknown"
        );
        assert_eq!(reply(b"not json"), None);
        assert_eq!(
            decode_widget_configuration(br#"{"configured":false}"#, false),
            None
        );
    }

    #[test]
    fn versions_parse_without_being_fooled_by_a_build_suffix() {
        assert_eq!(parse_version("14.0"), Some((14, 0)));
        assert_eq!(parse_version("27.0.1"), Some((27, 0)));
        assert_eq!(parse_version("26"), Some((26, 0)));
        assert_eq!(parse_version("beta"), None);
    }
}
