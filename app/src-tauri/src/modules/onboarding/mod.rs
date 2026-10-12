//! Onboarding progress.
//!
//! The flow demonstrates what the app does rather than gating access behind an
//! account, so there is no auth here by design. What must persist is *where the
//! user got to*, so "skip" resumes in the right place instead of restarting.
//!
//! State lives in the shared SQLite database — the renderer never holds it:
//! webview storage is not the app's and does not survive a cleared webview
//! data directory. A pre-database install's `onboarding.json` is imported once
//! through [`Database::import_doc`], so a user who already finished the flow
//! never sees it restart after an upgrade; the import's consume-on-sight rule
//! is what keeps a stale file from replaying over newer state forever.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::shared::database::Database;
use crate::shared::error::Error;

/// The document key this store owns inside the shared database.
const KEY: &str = "onboarding";

/// A step in the demonstration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OnboardingStep {
    /// What the app is for.
    Welcome,
    /// Live status of the provider.
    StatusCheck,
    /// The 5-hour window and how rollover is detected.
    WindowRollover,
    /// Setting up the desktop widget.
    Widget,
    /// Automation preferences.
    Automation,
    Done,
}

impl OnboardingStep {
    /// Ordinal used for progress arithmetic. Stable: persisted state stores
    /// the step, so reordering this changes meaning.
    ///
    /// Ordinal used for progress arithmetic, exposed over IPC so the renderer
    /// can show "step 3 of 6" without duplicating the ordering.
    pub const fn index(self) -> u8 {
        match self {
            Self::Welcome => 0,
            Self::StatusCheck => 1,
            Self::WindowRollover => 2,
            Self::Widget => 3,
            Self::Automation => 4,
            Self::Done => 5,
        }
    }

    /// Every step in order.
    pub const ALL: [OnboardingStep; 6] = [
        Self::Welcome,
        Self::StatusCheck,
        Self::WindowRollover,
        Self::Widget,
        Self::Automation,
        Self::Done,
    ];

    /// Parses a persisted string, defaulting to the first step so a corrupt
    /// document cannot strand the user past the end.
    pub fn from_wire(value: &str) -> Self {
        Self::ALL
            .into_iter()
            .find(|step| step.as_wire() == value)
            .unwrap_or(Self::Welcome)
    }

    pub const fn as_wire(self) -> &'static str {
        match self {
            Self::Welcome => "welcome",
            Self::StatusCheck => "statusCheck",
            Self::WindowRollover => "windowRollover",
            Self::Widget => "widget",
            Self::Automation => "automation",
            Self::Done => "done",
        }
    }
}

/// Persisted onboarding progress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingState {
    /// The furthest step reached.
    pub step: OnboardingStep,
    /// The user dismissed the flow before reaching the end.
    pub dismissed: bool,
}

impl OnboardingState {
    /// Whether the flow should be shown on launch.
    ///
    /// Reaching the end counts as dismissed, so the flow does not reappear for
    /// a user who completed it rather than skipped it.
    pub fn should_show(&self) -> bool {
        !self.dismissed && self.step != OnboardingStep::Done
    }
}

/// Progress shaped for a progress indicator.
///
/// The renderer must not reimplement the step ordering: doing so would let the
/// two drift and silently mis-report progress.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingProgress {
    pub step: OnboardingStep,
    pub dismissed: bool,
    /// Zero-based position of `step`.
    pub index: u8,
    /// Number of steps in the flow.
    pub total: u8,
    /// Whether the flow should be shown on launch.
    ///
    /// Decided in Rust so the rule sits beside the persisted state and the
    /// renderer cannot disagree about when the flow reappears.
    pub visible: bool,
}

/// Reads and writes the onboarding state.
#[derive(Clone)]
pub struct OnboardingStore {
    db: Arc<Database>,
    legacy: Option<PathBuf>,
}

impl OnboardingStore {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db, legacy: None }
    }

    /// Names the pre-database file to import on first sight, when one exists.
    pub fn with_legacy(mut self, path: Option<PathBuf>) -> Self {
        self.legacy = path;
        self
    }

    /// Reads the persisted state, defaulting to a fresh start.
    ///
    /// A missing document is the normal first-run case. An unreadable or
    /// corrupt one also defaults rather than failing: onboarding must never be
    /// able to block the app from launching.
    pub fn load(&self) -> OnboardingState {
        self.import_legacy();

        let Ok(raw) = self.db.read_doc(KEY) else {
            return Self::fresh();
        };

        #[derive(Deserialize)]
        struct Persisted {
            step: Option<String>,
            dismissed: Option<bool>,
        }

        raw.as_deref()
            .and_then(|raw| serde_json::from_str::<Persisted>(raw).ok())
            .map(|parsed| OnboardingState {
                step: parsed
                    .step
                    .as_deref()
                    .map(OnboardingStep::from_wire)
                    .unwrap_or(OnboardingStep::Welcome),
                dismissed: parsed.dismissed.unwrap_or(false),
            })
            .unwrap_or_else(Self::fresh)
    }

    /// Persists the state.
    ///
    /// A failed write is reported rather than swallowed: silently losing
    /// progress would restart the whole flow on the next launch.
    pub fn save(&self, state: &OnboardingState) -> Result<(), Error> {
        let encoded = serde_json::to_string(state).map_err(|err| {
            Error::storage(format!("Onboarding state could not be encoded: {err}"))
        })?;
        self.db.write_doc(KEY, &encoded)?;
        self.consume_legacy();
        Ok(())
    }

    /// Hands a predecessor file to the database before the first read, so an
    /// upgraded install resumes where it left off.
    fn import_legacy(&self) {
        if let Err(error) = self.db.import_doc(KEY, self.legacy.as_deref()) {
            log::warn!("could not import onboarding state: {}", error.message);
        }
    }

    /// Retires a predecessor file after a write, so it can never replay over
    /// newer state.
    fn consume_legacy(&self) {
        if let Err(error) = self.db.consume_doc(self.legacy.as_deref()) {
            log::warn!(
                "could not retire the old onboarding store: {}",
                error.message
            );
        }
    }

    /// The state every install starts from.
    fn fresh() -> OnboardingState {
        OnboardingState {
            step: OnboardingStep::Welcome,
            dismissed: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    /// A store over a throwaway database, plus the pre-database file path it
    /// would import from.
    fn store(name: &str) -> (OnboardingStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("agentgauge-onboarding-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("creates dir");
        let db = Database::open(&dir.join("agentgauge.db")).expect("opens");
        let legacy = dir.join("onboarding.json");
        (
            OnboardingStore::new(Arc::new(db)).with_legacy(Some(legacy.clone())),
            legacy,
        )
    }

    fn write_legacy(path: &Path, contents: &str) {
        fs::write(path, contents).expect("writes the legacy file");
    }

    #[test]
    fn a_missing_document_and_no_legacy_start_at_welcome() {
        let (store, _) = store("missing");
        let state = store.load();
        assert_eq!(state.step, OnboardingStep::Welcome);
        assert!(!state.dismissed);
    }

    #[test]
    fn saves_and_reloads_a_step() {
        let (store, _) = store("roundtrip");
        let state = OnboardingState {
            step: OnboardingStep::WindowRollover,
            dismissed: false,
        };
        store.save(&state).expect("saves");
        assert_eq!(store.load(), state);
    }

    #[test]
    fn a_completed_flow_survives_the_upgrade_to_the_database() {
        // The cold-start regression: an install that had finished onboarding
        // must not be thrown back to the start by the storage migration.
        let (store, legacy) = store("upgrade-done");
        write_legacy(&legacy, r#"{"step":"done","dismissed":true}"#);

        let state = store.load();

        assert_eq!(state.step, OnboardingStep::Done);
        assert!(state.dismissed);
        assert!(!state.should_show());
        assert!(
            !legacy.exists(),
            "the imported file must be spent, or it would replay forever"
        );
        assert!(legacy.with_extension("json.imported").exists());
    }

    #[test]
    fn a_mid_flow_upgrade_resumes_at_the_reached_step() {
        let (store, legacy) = store("upgrade-mid");
        write_legacy(&legacy, r#"{"step":"widget","dismissed":false}"#);

        let state = store.load();

        assert_eq!(state.step, OnboardingStep::Widget);
        assert!(state.should_show());
    }

    #[test]
    fn an_upgrade_can_never_un_finish_itself() {
        // Import, then the user's own state advances past the file. On the
        // next read — the next cold start — the spent file must not replay.
        let (store, legacy) = store("upgrade-noreplay");
        write_legacy(&legacy, r#"{"step":"welcome","dismissed":false}"#);
        assert!(store.load().should_show());

        store
            .save(&OnboardingState {
                step: OnboardingStep::Done,
                dismissed: true,
            })
            .expect("saves");

        let state = store.load();
        assert_eq!(state.step, OnboardingStep::Done);
        assert!(state.dismissed);
    }

    #[test]
    fn a_new_seed_while_the_file_is_unspent_is_honoured() {
        // The e2e harness re-seeds the gate between boots; a boot must read
        // the newest seed rather than a once-imported older one.
        let (store, legacy) = store("reseed");
        write_legacy(&legacy, r#"{"step":"done","dismissed":true}"#);
        assert!(!store.load().should_show());

        write_legacy(&legacy, r#"{"step":"statusCheck","dismissed":false}"#);
        assert!(store.load().should_show());
    }

    #[test]
    fn a_corrupt_document_falls_back_to_the_start() {
        // Onboarding must never be able to block launch.
        let (store, _) = store("corrupt-doc");
        store
            .db
            .write_doc(KEY, "{ not json")
            .expect("seeds a corrupt document");
        let state = store.load();
        assert_eq!(state.step, OnboardingStep::Welcome);
    }

    #[test]
    fn a_corrupt_legacy_file_is_spent_without_importing() {
        let (store, legacy) = store("corrupt-legacy");
        write_legacy(&legacy, "{ not json");

        let state = store.load();

        assert_eq!(state.step, OnboardingStep::Welcome);
        assert!(legacy.with_extension("json.imported").exists());
    }

    #[test]
    fn an_unknown_step_string_falls_back_to_the_start() {
        let (store, legacy) = store("unknown-step");
        write_legacy(&legacy, r#"{"step":"teleport","dismissed":true}"#);
        let state = store.load();
        assert_eq!(state.step, OnboardingStep::Welcome);
        assert!(state.dismissed, "other fields still load");
    }

    #[test]
    fn an_unreadable_legacy_path_degrades_instead_of_failing() {
        // A path whose ancestor is a regular file can never exist. Reading
        // must still yield a usable state rather than blocking launch.
        let dir = std::env::temp_dir().join("agentgauge-onboarding-blocked-parent");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("creates dir");
        fs::write(dir.join("blocked"), "a file, not a directory").expect("writes a file");

        let db = Database::open(&dir.join("db.sqlite")).expect("opens");
        let store = OnboardingStore::new(Arc::new(db))
            .with_legacy(Some(dir.join("blocked").join("onboarding.json")));

        assert_eq!(store.load().step, OnboardingStep::Welcome);
    }

    #[test]
    fn a_failed_write_is_reported_not_swallowed() {
        // Losing progress silently would send the user through the whole flow
        // again, so a failed write must surface as an error.
        let dir = std::env::temp_dir().join("agentgauge-onboarding-readonly");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("creates dir");
        let path = dir.join("agentgauge.db");
        {
            let db = Database::open(&path).expect("creates the schema");
            db.write_doc(KEY, r#"{"step":"welcome","dismissed":false}"#)
                .expect("seeds");
        }
        let conn = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("opens read-only");
        let store = OnboardingStore::new(Arc::new(Database::from_connection(conn).expect("wraps")));

        let err = store.save(&OnboardingState {
            step: OnboardingStep::Done,
            dismissed: false,
        });
        assert!(err.is_err(), "a failed write must be reported");
    }

    #[test]
    fn every_step_round_trips_through_its_wire_name() {
        for step in OnboardingStep::ALL {
            assert_eq!(OnboardingStep::from_wire(step.as_wire()), step);
        }
    }

    #[test]
    fn steps_are_ordered_and_finish_at_done() {
        let indexes: Vec<u8> = OnboardingStep::ALL.iter().map(|s| s.index()).collect();
        assert_eq!(indexes, vec![0, 1, 2, 3, 4, 5]);
        assert_eq!(OnboardingStep::ALL.last(), Some(&OnboardingStep::Done));
    }

    #[test]
    fn dismissing_hides_the_flow() {
        let state = OnboardingState {
            step: OnboardingStep::Widget,
            dismissed: true,
        };
        assert!(!state.should_show());
    }

    #[test]
    fn reaching_the_end_hides_the_flow_even_without_an_explicit_skip() {
        // Completing the flow must not leave it reappearing on every launch.
        let state = OnboardingState {
            step: OnboardingStep::Done,
            dismissed: false,
        };
        assert!(!state.should_show());
    }

    #[test]
    fn an_intermediate_step_still_shows_the_flow() {
        let state = OnboardingState {
            step: OnboardingStep::WindowRollover,
            dismissed: false,
        };
        assert!(state.should_show());
    }

    #[test]
    fn dismissal_is_persisted() {
        let (store, _) = store("dismissed");
        let state = OnboardingState {
            step: OnboardingStep::Widget,
            dismissed: true,
        };
        store.save(&state).expect("saves");
        assert!(store.load().dismissed);
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;

    /// The wire names the client schema must contain.
    #[test]
    fn the_step_order_is_the_contract_the_client_mirrors() {
        // The ordinal is persisted, so a reorder silently changes the meaning of
        // saved progress. `src/lib/ipc.ts` asserts the same six names.
        let names: Vec<&str> = OnboardingStep::ALL
            .iter()
            .map(|step| serde_json::to_value(step).expect("serialises"))
            .map(|json| json.as_str().expect("a bare string tag").to_string().leak() as &str)
            .collect();

        assert_eq!(
            names,
            vec![
                "welcome",
                "statusCheck",
                "windowRollover",
                "widget",
                "automation",
                "done"
            ]
        );
    }

    #[test]
    fn every_step_has_a_distinct_ordinal() {
        let mut indices: Vec<u8> = OnboardingStep::ALL.iter().map(|s| s.index()).collect();
        let count = indices.len();
        indices.sort_unstable();
        indices.dedup();
        assert_eq!(indices.len(), count, "ordinals must be unique");
    }

    #[test]
    fn the_last_step_is_the_final_one() {
        assert_eq!(OnboardingStep::ALL.last(), Some(&OnboardingStep::Done));
    }
}
