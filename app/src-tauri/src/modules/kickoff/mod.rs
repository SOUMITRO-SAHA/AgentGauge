//! The scheduled kickoff: one trivial prompt per connected sub, on schedule.
//!
//! # What the kickoff actually does
//!
//! A prompt cannot restart a 5-hour window — `resetsAt` is the provider's own
//! computation and is only ever read. What a prompt *can* do is open the next
//! window promptly: after a window's reset time passes, the first request
//! opens the fresh one, and the kickoff makes that first request a deliberate,
//! tiny one at a predictable time (about a minute after the reset) instead of
//! whenever real work happens to arrive.
//!
//! It spends quota, so it exists only behind an explicit per-subscription
//! switch, and nothing runs unless that switch wrote `enabled` into the
//! schedule file. The worker (`worker`) runs headless — launched by the
//! system scheduler, not by the app window — and reads the same file, which
//! is also where the desktop app records every fresh reset time it sees.

pub(crate) mod agent;
pub(crate) mod worker;

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::shared::domain::ProviderKind;
use crate::shared::error::Error;

/// The prompt the kickoff sends. Deliberately trivial and content-free: the
/// point is to open the window, not to make the model do work.
pub const KICKOFF_PROMPT: &str = "hi";

/// Length of the window the kickoff re-anchors, in milliseconds.
///
/// All four providers use a 5-hour rolling window; the value is the constant
/// every provider reports (`windowDurationMins: 300`, `unit×number` 5h), not a
/// guess per provider.
pub const WINDOW_MS: i64 = 5 * 60 * 60 * 1000;

/// How long after a reset the kickoff fires.
pub const KICK_DELAY_MS: i64 = 60_000;

/// How long to wait after a failed attempt before trying again.
pub const RETRY_MS: i64 = 5 * 60 * 1000;

/// Where the shared schedule lives, relative to `$HOME`.
///
/// The same directory the widget snapshot uses, for the same reason: the
/// desktop app and a second process (the worker) must agree on a path without
/// either depending on the other.
pub const SCHEDULE_RELATIVE_PATH: &str =
    "Library/Application Support/AI Sub Stats/kickoff-schedule.json";

/// Bumped when the schedule shape changes. An unrecognised version is treated
/// as no schedule rather than as a schedule that may not mean what it says.
pub const SCHEDULE_VERSION: u32 = 1;

/// Longest detail kept for the UI, in characters. A provider reply or error
/// is context, not data, and must not turn the schedule file into a log.
const MAX_DETAIL_CHARS: usize = 200;

// The model catalog lives in `shared/domain.rs` — the provider pipeline needs
// the same cheapest-default answer the picker shapes for the renderer.
pub use crate::shared::domain::{cheapest_model, is_known_model, models_for};

/// One subscription's kickoff configuration and schedule, as shared with the
/// worker through the schedule file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KickoffSubscription {
    pub kind: ProviderKind,
    /// The explicit opt-in. `false` is the default and only the renderer's
    /// `setKickoffEnabled` writes a `true`.
    pub enabled: bool,
    /// The user's model choice, or `None` for the cheapest default.
    pub model_id: Option<String>,
    /// Unix **seconds** of the window reset this schedule is built from.
    pub resets_at: Option<i64>,
    /// Epoch **milliseconds** at which the next kickoff may fire.
    pub next_kick_at: Option<i64>,
    /// Epoch **milliseconds** of the last attempt.
    pub last_kick_at: Option<i64>,
    /// What the last attempt did, when there was one.
    pub last_accepted: Option<bool>,
    /// The last attempt's reply or failure reason, bounded.
    pub last_detail: Option<String>,
}

impl KickoffSubscription {
    /// The state a subscription starts in: opted out, never scheduled.
    pub fn new(kind: ProviderKind) -> Self {
        Self {
            kind,
            enabled: false,
            model_id: None,
            resets_at: None,
            next_kick_at: None,
            last_kick_at: None,
            last_accepted: None,
            last_detail: None,
        }
    }

    /// The model the next kickoff would actually send.
    ///
    /// An override this build does not recognise falls back to the cheapest:
    /// a vendor may retire a slug, and an unknown slug must degrade to the
    /// deliberate default rather than fail every future attempt.
    pub fn selected_model(&self) -> &'static str {
        let selected = self
            .model_id
            .as_deref()
            .filter(|id| is_known_model(self.kind, id));
        if let Some(id) = selected {
            if let Some(model) = models_for(self.kind).iter().find(|m| m.id == id) {
                return model.id;
            }
        }
        cheapest_model(self.kind)
    }

    /// Applies the opt-in. Turning it on schedules the first attempt: from the
    /// known reset when one is ahead of us, otherwise immediately — the first
    /// tiny prompt is what anchors the 5-hour cadence. Turning it off clears
    /// the schedule; nothing else may clear `enabled`.
    pub fn set_enabled(&mut self, enabled: bool, now_ms: i64) {
        self.enabled = enabled;
        if enabled {
            let scheduled = self
                .resets_at
                .map(|secs| secs * 1000 + KICK_DELAY_MS)
                .unwrap_or(now_ms);
            self.next_kick_at = Some(scheduled.max(now_ms));
        } else {
            self.next_kick_at = None;
        }
    }

    /// Selects the model. `None` returns to the cheapest default.
    pub fn set_model(&mut self, model_id: Option<String>) {
        self.model_id = model_id;
    }

    /// Folds a freshly observed reset time into the schedule.
    ///
    /// A *forward-moving* reset is the provider saying a window restarted —
    /// possibly from the user's own activity — so the schedule re-anchors to
    /// it and the kickoff for the old reset quietly stops being due. A reset
    /// that has already passed schedules immediately: opening the current
    /// window late still anchors the cadence. Re-observing the same value is
    /// a no-op, so steady polling never rewrites the schedule.
    pub fn apply_reset(&mut self, resets_at_secs: i64, now_ms: i64) {
        if self.resets_at == Some(resets_at_secs) {
            return;
        }
        self.resets_at = Some(resets_at_secs);
        let kick_at = resets_at_secs * 1000 + KICK_DELAY_MS;
        self.next_kick_at = Some(kick_at.max(now_ms));
    }

    /// Records a successful attempt and self-anchors: the window this attempt
    /// opened ends five hours from now, so the next kickoff is known exactly
    /// — the worker needs no provider read to stay on schedule.
    pub fn record_success(&mut self, now_ms: i64, reply: &str) {
        self.last_kick_at = Some(now_ms);
        self.last_accepted = Some(true);
        self.last_detail = Some(bounded(reply));
        self.resets_at = Some((now_ms + WINDOW_MS) / 1000);
        self.next_kick_at = Some(now_ms + WINDOW_MS + KICK_DELAY_MS);
    }

    /// Records a failed attempt and backs off. The schedule stays armed: a
    /// transient failure must not silently drop the sub until the next reset.
    pub fn record_failure(&mut self, now_ms: i64, detail: &str) {
        self.last_kick_at = Some(now_ms);
        self.last_accepted = Some(false);
        self.last_detail = Some(bounded(detail));
        self.next_kick_at = Some(now_ms + RETRY_MS);
    }

    /// Whether a kickoff may fire right now: opted in, scheduled, and due.
    pub fn is_due(&self, now_ms: i64) -> bool {
        self.enabled && self.next_kick_at.is_some_and(|at| now_ms >= at)
    }
}

/// Truncates a detail to the bounded length.
fn bounded(detail: &str) -> String {
    if detail.chars().count() <= MAX_DETAIL_CHARS {
        return detail.to_string();
    }
    let head: String = detail.chars().take(MAX_DETAIL_CHARS).collect();
    format!("{head}…")
}

/// The whole schedule file: what runs, and when it last ran.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KickoffSchedule {
    pub version: u32,
    pub subscriptions: Vec<KickoffSubscription>,
}

impl KickoffSchedule {
    /// The schedule every installation starts from: every known sub present,
    /// every sub opted out.
    pub fn default_with_all_kinds() -> Self {
        Self {
            version: SCHEDULE_VERSION,
            subscriptions: [
                ProviderKind::Codex,
                ProviderKind::Zai,
                ProviderKind::Minimax,
                ProviderKind::Kimi,
            ]
            .into_iter()
            .map(KickoffSubscription::new)
            .collect(),
        }
    }

    /// Whether any subscription is opted in — the condition for the system
    /// scheduler to be installed.
    pub fn any_enabled(&self) -> bool {
        self.subscriptions.iter().any(|sub| sub.enabled)
    }
}

/// Reads and writes the shared kickoff schedule.
pub struct KickoffStore {
    path: PathBuf,
}

impl KickoffStore {
    /// Resolves the store from `$HOME`.
    ///
    /// `None` when `HOME` is unset: without a home directory there is nowhere
    /// to share the schedule from, and the kickoff surfaces as unsupported
    /// rather than pretending to be configured.
    pub fn from_env() -> Option<Self> {
        let home = std::env::var_os("HOME")?;
        Some(Self {
            path: Path::new(&home).join(SCHEDULE_RELATIVE_PATH),
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

    /// Reads the schedule, defaulting to all-opted-out.
    ///
    /// A missing file is the normal first-run case; a corrupt file or an
    /// unrecognised version is treated the same way, because a schedule that
    /// cannot be understood must never be guessed at.
    pub fn load(&self) -> KickoffSchedule {
        let Ok(raw) = fs::read_to_string(&self.path) else {
            return KickoffSchedule::default_with_all_kinds();
        };
        let Ok(parsed) = serde_json::from_str::<KickoffSchedule>(&raw) else {
            return KickoffSchedule::default_with_all_kinds();
        };
        if parsed.version != SCHEDULE_VERSION {
            return KickoffSchedule::default_with_all_kinds();
        }
        parsed
    }

    /// Persists the schedule atomically, so the worker never reads a
    /// half-written file — the same contract the widget snapshot keeps with
    /// its reader.
    pub fn save(&self, schedule: &KickoffSchedule) -> Result<(), Error> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|err| {
                Error::storage(format!("Could not create the schedule directory: {err}"))
            })?;
        }

        let encoded = serde_json::to_string_pretty(schedule)
            .map_err(|err| Error::storage(format!("The schedule could not be encoded: {err}")))?;

        let temp = self.path.with_extension("json.tmp");
        fs::write(&temp, encoded)
            .map_err(|err| Error::storage(format!("The schedule could not be saved: {err}")))?;
        fs::rename(&temp, &self.path).map_err(|err| {
            let _ = fs::remove_file(&temp);
            Error::storage(format!("The schedule could not be saved: {err}"))
        })
    }

    /// Applies `change` to one subscription, inserting a default entry when
    /// the file has never mentioned it, and persists the result.
    pub fn update(
        &self,
        kind: ProviderKind,
        change: impl FnOnce(KickoffSubscription) -> KickoffSubscription,
    ) -> Result<KickoffSubscription, Error> {
        let mut schedule = self.load();
        let position = schedule
            .subscriptions
            .iter()
            .position(|sub| sub.kind == kind);
        let updated = match position {
            Some(index) => {
                let updated = change(schedule.subscriptions[index].clone());
                schedule.subscriptions[index] = updated.clone();
                updated
            }
            None => {
                let updated = change(KickoffSubscription::new(kind));
                schedule.subscriptions.push(updated.clone());
                updated
            }
        };
        schedule.version = SCHEDULE_VERSION;
        self.save(&schedule)?;
        Ok(updated)
    }
}

/// What the renderer learns from one `kickoffState` request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KickoffView {
    pub kind: ProviderKind,
    pub enabled: bool,
    /// The user's selection, if any — distinct from what would be sent.
    pub model_id: Option<String>,
    /// The model the next kickoff would actually use.
    pub effective_model: String,
    /// Everything the picker may offer.
    pub models: Vec<KickoffModelDto>,
    /// Epoch ms of the next scheduled attempt, if one is armed.
    pub next_kick_at: Option<i64>,
    pub last_kick_at: Option<i64>,
    pub last_accepted: Option<bool>,
    pub last_detail: Option<String>,
}

/// One picker row on the wire. Owns its strings, unlike the shared catalog
/// whose entries are static.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KickoffModelDto {
    pub id: String,
    pub label: String,
    pub cheapest: bool,
}

/// Whether the system scheduler can run, and whether it is installed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerStatus {
    pub supported: bool,
    pub installed: bool,
}

/// The full kickoff overview: every sub plus the scheduler's status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KickoffOverview {
    pub subscriptions: Vec<KickoffView>,
    pub scheduler: SchedulerStatus,
}

/// Builds the overview the renderer reads.
///
/// All four kinds are listed whether connected or not: the Usage tab already
/// decides which subs exist, and a schedule row for a not-yet-connected sub
/// is the user's saved intent, not a fabrication.
pub fn overview(store: Option<&KickoffStore>) -> KickoffOverview {
    let schedule = store
        .map(|store| store.load())
        .unwrap_or_else(KickoffSchedule::default_with_all_kinds);

    let subscriptions = [
        ProviderKind::Codex,
        ProviderKind::Zai,
        ProviderKind::Minimax,
        ProviderKind::Kimi,
    ]
    .into_iter()
    .map(|kind| {
        let sub = schedule
            .subscriptions
            .iter()
            .find(|sub| sub.kind == kind)
            .cloned()
            .unwrap_or_else(|| KickoffSubscription::new(kind));
        KickoffView {
            kind,
            enabled: sub.enabled,
            model_id: sub.model_id.clone(),
            effective_model: sub.selected_model().to_string(),
            models: models_for(kind)
                .iter()
                .map(|model| KickoffModelDto {
                    id: model.id.to_string(),
                    label: model.label.to_string(),
                    cheapest: model.cheapest,
                })
                .collect(),
            next_kick_at: sub.next_kick_at,
            last_kick_at: sub.last_kick_at,
            last_accepted: sub.last_accepted,
            last_detail: sub.last_detail,
        }
    })
    .collect();

    KickoffOverview {
        subscriptions,
        scheduler: SchedulerStatus {
            supported: cfg!(target_os = "macos"),
            installed: agent::is_installed(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY_MS: i64 = 24 * 60 * 60 * 1000;

    fn sub(kind: ProviderKind) -> KickoffSubscription {
        KickoffSubscription::new(kind)
    }

    #[test]
    fn a_new_subscription_is_opted_out_and_never_due() {
        let sub = sub(ProviderKind::Codex);
        assert!(!sub.enabled);
        assert!(!sub.is_due(DAY_MS));
        assert_eq!(sub.next_kick_at, None);
    }

    #[test]
    fn enabling_with_a_future_reset_schedules_one_minute_after_it() {
        let mut sub = sub(ProviderKind::Codex);
        sub.apply_reset(1_000_000, 0);
        let now = 500_000;
        sub.set_enabled(true, now);
        assert_eq!(sub.next_kick_at, Some(1_000_000 * 1000 + KICK_DELAY_MS));
        assert!(!sub.is_due(now));
    }

    #[test]
    fn enabling_with_a_passed_reset_anchors_immediately() {
        // The first tiny prompt is what starts the 5-hour cadence when the
        // reset time is already behind us.
        let mut sub = sub(ProviderKind::Codex);
        sub.apply_reset(1_000, 2_000_000);
        sub.set_enabled(true, 2_000_000);
        assert_eq!(sub.next_kick_at, Some(2_000_000));
        assert!(sub.is_due(2_000_000));
    }

    #[test]
    fn enabling_with_no_known_reset_anchors_immediately() {
        let mut sub = sub(ProviderKind::Zai);
        sub.set_enabled(true, 42_000);
        assert_eq!(sub.next_kick_at, Some(42_000));
    }

    #[test]
    fn disabling_clears_the_schedule_but_not_the_choice() {
        let mut sub = sub(ProviderKind::Codex);
        sub.set_enabled(true, 0);
        sub.set_enabled(false, 1_000);
        assert!(!sub.enabled);
        assert_eq!(sub.next_kick_at, None);
        assert!(!sub.is_due(9_000_000_000));
    }

    #[test]
    fn a_forward_moving_reset_reanchors_and_supersedes_the_old_schedule() {
        // The user's own activity restarted the window; the kickoff for the
        // old reset must quietly stop being due.
        let mut sub = sub(ProviderKind::Codex);
        sub.set_enabled(true, 0);
        sub.apply_reset(10_000, 0);
        assert_eq!(sub.next_kick_at, Some(10_000 * 1000 + KICK_DELAY_MS));
        sub.apply_reset(90_000, 20_000_000);
        assert_eq!(sub.next_kick_at, Some(90_000 * 1000 + KICK_DELAY_MS));
        assert!(!sub.is_due(10_000 * 1000 + KICK_DELAY_MS + 1));
    }

    #[test]
    fn reobserving_the_same_reset_is_a_no_op() {
        let mut sub = sub(ProviderKind::Codex);
        sub.apply_reset(10_000, 0);
        let before = sub.clone();
        sub.apply_reset(10_000, DAY_MS);
        assert_eq!(sub, before);
    }

    #[test]
    fn a_success_anchors_the_next_window_exactly() {
        let mut sub = sub(ProviderKind::Codex);
        sub.set_enabled(true, 0);
        sub.record_success(1_000_000, "Hello!");
        assert_eq!(sub.last_accepted, Some(true));
        assert_eq!(sub.last_detail.as_deref(), Some("Hello!"));
        assert_eq!(
            sub.next_kick_at,
            Some(1_000_000 + WINDOW_MS + KICK_DELAY_MS)
        );
        assert_eq!(sub.resets_at, Some((1_000_000 + WINDOW_MS) / 1000));
        assert!(!sub.is_due(1_000_000 + WINDOW_MS));
        assert!(sub.is_due(1_000_000 + WINDOW_MS + KICK_DELAY_MS));
    }

    #[test]
    fn a_failure_backs_off_without_disarming() {
        let mut sub = sub(ProviderKind::Zai);
        sub.set_enabled(true, 0);
        sub.record_failure(1_000_000, "HTTP 503");
        assert_eq!(sub.last_accepted, Some(false));
        assert_eq!(sub.next_kick_at, Some(1_000_000 + RETRY_MS));
        assert!(sub.is_due(1_000_000 + RETRY_MS));
    }

    #[test]
    fn an_over_long_detail_is_truncated() {
        let mut sub = sub(ProviderKind::Codex);
        sub.record_success(0, &"x".repeat(MAX_DETAIL_CHARS + 10));
        let detail = sub.last_detail.expect("detail");
        assert_eq!(detail.chars().count(), MAX_DETAIL_CHARS + 1);
        assert!(detail.ends_with('…'));
    }

    #[test]
    fn the_default_selection_is_the_cheapest_model() {
        for kind in [
            ProviderKind::Codex,
            ProviderKind::Zai,
            ProviderKind::Minimax,
            ProviderKind::Kimi,
        ] {
            assert_eq!(sub(kind).selected_model(), cheapest_model(kind));
        }
    }

    #[test]
    fn a_known_override_is_honoured_and_an_unknown_one_falls_back() {
        let mut sub = sub(ProviderKind::Zai);
        sub.set_model(Some("glm-5.3".into()));
        assert_eq!(sub.selected_model(), "glm-5.3");
        sub.set_model(Some("glm-9.9-retired".into()));
        assert_eq!(sub.selected_model(), cheapest_model(ProviderKind::Zai));
    }

    fn temp_store(name: &str) -> KickoffStore {
        let dir = std::env::temp_dir().join(format!("agentgauge-kickoff-{name}"));
        let _ = fs::remove_dir_all(&dir);
        KickoffStore::at(dir.join("nested").join("kickoff-schedule.json"))
    }

    #[test]
    fn a_missing_file_starts_all_opted_out() {
        let store = temp_store("missing");
        let schedule = store.load();
        assert!(schedule.subscriptions.iter().all(|sub| !sub.enabled));
        assert_eq!(schedule.subscriptions.len(), 4);
        assert!(!schedule.any_enabled());
    }

    #[test]
    fn a_choice_survives_a_round_trip_in_the_wire_shape() {
        let store = temp_store("round-trip");
        store
            .update(ProviderKind::Zai, |mut sub| {
                sub.set_enabled(true, 1_000);
                sub.set_model(Some("glm-5.3-flash".into()));
                sub
            })
            .expect("saves");

        let raw = fs::read_to_string(store.path()).expect("reads");
        assert!(
            raw.contains("\"enabled\": true"),
            "wire must be camelCase: {raw}"
        );
        assert!(raw.contains("\"modelId\""), "wire must be camelCase: {raw}");

        let schedule = store.load();
        let zai = schedule
            .subscriptions
            .iter()
            .find(|sub| sub.kind == ProviderKind::Zai)
            .expect("entry");
        assert!(zai.enabled);
        assert_eq!(zai.model_id.as_deref(), Some("glm-5.3-flash"));
        assert!(schedule.any_enabled());
    }

    #[test]
    fn update_inserts_an_entry_the_file_never_had() {
        let store = temp_store("upsert");
        std::fs::create_dir_all(store.path().parent().unwrap()).expect("dir");
        std::fs::write(
            store.path(),
            r#"{"version":1,"subscriptions":[{"kind":"codex","enabled":false,"modelId":null,"resetsAt":null,"nextKickAt":null,"lastKickAt":null,"lastAccepted":null,"lastDetail":null}]}"#,
        )
        .expect("seed");

        store
            .update(ProviderKind::Kimi, |mut sub| {
                sub.set_enabled(true, 0);
                sub
            })
            .expect("saves");

        let schedule = store.load();
        assert!(schedule
            .subscriptions
            .iter()
            .any(|sub| sub.kind == ProviderKind::Kimi && sub.enabled));
    }

    #[test]
    fn a_corrupt_file_falls_back_to_opted_out() {
        let store = temp_store("corrupt");
        std::fs::create_dir_all(store.path().parent().unwrap()).expect("dir");
        std::fs::write(store.path(), "{ not json").expect("write");
        assert!(!store.load().any_enabled());
    }

    #[test]
    fn an_unrecognised_version_is_not_trusted() {
        let store = temp_store("version");
        std::fs::create_dir_all(store.path().parent().unwrap()).expect("dir");
        std::fs::write(
            store.path(),
            r#"{"version":99,"subscriptions":[{"kind":"codex","enabled":true}]}"#,
        )
        .expect("write");
        assert!(!store.load().any_enabled());
    }

    #[test]
    fn a_failed_save_is_reported_not_swallowed() {
        let dir = std::env::temp_dir().join("agentgauge-kickoff-blocked");
        let _ = fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let blocker = dir.join("kickoff-schedule.json");
        std::fs::create_dir_all(&blocker).expect("blocker");

        let result = KickoffStore::at(blocker).update(ProviderKind::Codex, |sub| sub);
        assert!(result.is_err(), "a failed save must be reported");
    }

    #[test]
    fn the_overview_lists_every_kind_and_the_effective_model() {
        let store = temp_store("overview");
        store
            .update(ProviderKind::Kimi, |mut sub| {
                sub.set_model(Some("kimi-for-coding".into()));
                sub
            })
            .expect("saves");

        let overview = overview(Some(&store));
        assert_eq!(overview.subscriptions.len(), 4);
        let kimi = overview
            .subscriptions
            .iter()
            .find(|view| view.kind == ProviderKind::Kimi)
            .expect("kimi");
        assert_eq!(kimi.model_id.as_deref(), Some("kimi-for-coding"));
        assert_eq!(kimi.effective_model, "kimi-for-coding");
        assert!(kimi.models.len() >= 2);

        let codex = overview
            .subscriptions
            .iter()
            .find(|view| view.kind == ProviderKind::Codex)
            .expect("codex");
        assert_eq!(codex.effective_model, cheapest_model(ProviderKind::Codex));
        assert!(!overview.scheduler.installed);
    }

    #[test]
    fn the_overview_without_a_store_still_renders() {
        let overview = overview(None);
        assert_eq!(overview.subscriptions.len(), 4);
        assert!(!overview.scheduler.installed);
    }
}
