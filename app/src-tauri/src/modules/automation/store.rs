//! Persisted automation choices and observed rollover state.
//!
//! Starting a sub's rollover monitor is a *choice*: it is written here the
//! moment it is made, and the runner re-reads this file at every launch, so a
//! sub the user enabled is running again before the first frame renders — the
//! Start button is an instruction, not a per-session ritual.
//!
//! The store keeps the choice *and* the observed rollover state, so the screen
//! restores continuity (baseline reset, an unacknowledged rollover, the last
//! check) instead of blanks. Volatile schedule fields (`nextPollAt`) are never
//! persisted; they are recomputed the moment the monitor resumes.
//!
//! Durability contract, the same one the settings and kickoff stores keep:
//! versioned (an unrecognised version is not trusted), atomic (sibling temp
//! file + rename, so a reader never sees a half-written store), and
//! corrupt-safe (a file that cannot be understood defaults to all-off rather
//! than being guessed at).

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::shared::domain::ProviderKind;
use crate::shared::error::Error;

/// Bumped when the record shape changes. An unrecognised version is treated as
/// no store rather than as a store that may not mean what it says.
pub const AUTOMATION_CONFIG_VERSION: u32 = 1;

/// One sub's persisted monitor choice and the state worth restoring.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRecord {
    pub kind: ProviderKind,
    /// The user's choice. This is the field `resume_persisted` acts on.
    pub enabled: bool,
    /// Unix **seconds** of the window reset the monitor last observed, so a
    /// rollover that happened while the app was closed is still detectable on
    /// the first poll after resume.
    pub observed_resets_at: Option<i64>,
    /// A rollover was detected and not yet acknowledged.
    pub rolled_over: bool,
    /// Epoch ms at which that rollover was detected.
    pub rolled_over_at: Option<i64>,
    /// Epoch ms of the last successful poll.
    pub last_polled_at: Option<i64>,
}

impl AutomationRecord {
    /// The record a sub starts from: opted out, nothing observed.
    pub fn new(kind: ProviderKind) -> Self {
        Self {
            kind,
            enabled: false,
            observed_resets_at: None,
            rolled_over: false,
            rolled_over_at: None,
            last_polled_at: None,
        }
    }
}

/// The whole store: one record per known sub.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationConfig {
    pub version: u32,
    pub records: Vec<AutomationRecord>,
}

impl AutomationConfig {
    /// The config every installation starts from: every known sub present,
    /// every sub opted out.
    pub fn default_with_all_kinds() -> Self {
        Self {
            version: AUTOMATION_CONFIG_VERSION,
            records: [
                ProviderKind::Codex,
                ProviderKind::Zai,
                ProviderKind::Minimax,
                ProviderKind::Kimi,
            ]
            .into_iter()
            .map(AutomationRecord::new)
            .collect(),
        }
    }
}

/// Reads and writes the persisted automation config.
pub struct AutomationStore {
    path: PathBuf,
}

impl AutomationStore {
    /// Builds a store at an explicit path — the app-data directory's
    /// `automation.json` in production.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Builds a store at an explicit path. For tests.
    #[cfg(test)]
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self::new(path)
    }

    #[cfg(test)]
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    /// Reads the config, defaulting to all-opted-out.
    ///
    /// A missing file is the normal first-run case; a corrupt file or an
    /// unrecognised version is treated the same way, because a config that
    /// cannot be understood must never be guessed at.
    pub fn load(&self) -> AutomationConfig {
        let Ok(raw) = fs::read_to_string(&self.path) else {
            return AutomationConfig::default_with_all_kinds();
        };
        let Ok(parsed) = serde_json::from_str::<AutomationConfig>(&raw) else {
            return AutomationConfig::default_with_all_kinds();
        };
        if parsed.version != AUTOMATION_CONFIG_VERSION {
            return AutomationConfig::default_with_all_kinds();
        }
        parsed
    }

    /// Persists the config atomically, so a concurrent reader (the runner
    /// persisting after a poll while the renderer toggles a switch) never
    /// observes a half-written file.
    pub fn save(&self, config: &AutomationConfig) -> Result<(), Error> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|err| {
                Error::storage(format!("Could not create the automation directory: {err}"))
            })?;
        }

        let encoded = serde_json::to_string_pretty(config)
            .map_err(|err| Error::storage(format!("The config could not be encoded: {err}")))?;

        let temp = self.path.with_extension("json.tmp");
        fs::write(&temp, encoded)
            .map_err(|err| Error::storage(format!("The config could not be saved: {err}")))?;
        fs::rename(&temp, &self.path).map_err(|err| {
            let _ = fs::remove_file(&temp);
            Error::storage(format!("The config could not be saved: {err}"))
        })
    }

    /// The record for `kind`, inserting the default when the file has never
    /// mentioned it.
    pub fn record(&self, kind: ProviderKind) -> AutomationRecord {
        self.load()
            .records
            .into_iter()
            .find(|record| record.kind == kind)
            .unwrap_or_else(|| AutomationRecord::new(kind))
    }

    /// Applies `change` to one record and persists the result.
    pub fn update(
        &self,
        kind: ProviderKind,
        change: impl FnOnce(AutomationRecord) -> AutomationRecord,
    ) -> Result<AutomationRecord, Error> {
        let mut config = self.load();
        let updated = match config.records.iter_mut().find(|r| r.kind == kind) {
            Some(record) => {
                *record = change(record.clone());
                record.clone()
            }
            None => {
                let record = change(AutomationRecord::new(kind));
                config.records.push(record.clone());
                record
            }
        };
        config.version = AUTOMATION_CONFIG_VERSION;
        self.save(&config)?;
        Ok(updated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(name: &str) -> AutomationStore {
        let dir = std::env::temp_dir().join(format!("agentgauge-automation-{name}"));
        let _ = fs::remove_dir_all(&dir);
        AutomationStore::at(dir.join("nested").join("automation.json"))
    }

    #[test]
    fn a_missing_file_starts_all_opted_out() {
        let store = temp_store("missing");
        let config = store.load();
        assert_eq!(config.records.len(), 4);
        assert!(config.records.iter().all(|record| !record.enabled));
    }

    #[test]
    fn the_choice_survives_a_round_trip_in_the_wire_shape() {
        let store = temp_store("round-trip");
        store
            .update(ProviderKind::Zai, |mut record| {
                record.enabled = true;
                record.observed_resets_at = Some(5_000);
                record
            })
            .expect("saves");

        let raw = fs::read_to_string(store.path()).expect("reads");
        assert!(
            raw.contains("\"enabled\": true"),
            "wire must be camelCase: {raw}"
        );
        assert!(
            raw.contains("\"observedResetsAt\""),
            "wire must be camelCase"
        );

        let record = store.record(ProviderKind::Zai);
        assert!(record.enabled);
        assert_eq!(record.observed_resets_at, Some(5_000));
    }

    #[test]
    fn update_inserts_a_record_the_file_never_had() {
        let store = temp_store("upsert");
        std::fs::create_dir_all(store.path().parent().unwrap()).expect("dir");
        std::fs::write(
            store.path(),
            r#"{"version":1,"records":[{"kind":"codex","enabled":false,"observedResetsAt":null,"rolledOver":false,"rolledOverAt":null,"lastPolledAt":null}]}"#,
        )
        .expect("seed");

        store
            .update(ProviderKind::Kimi, |mut record| {
                record.enabled = true;
                record
            })
            .expect("saves");

        assert!(store.record(ProviderKind::Kimi).enabled);
        assert!(!store.record(ProviderKind::Codex).enabled);
    }

    #[test]
    fn a_corrupt_file_falls_back_to_opted_out() {
        let store = temp_store("corrupt");
        std::fs::create_dir_all(store.path().parent().unwrap()).expect("dir");
        std::fs::write(store.path(), "{ not json").expect("write");
        assert!(!store.load().records.iter().any(|r| r.enabled));
    }

    #[test]
    fn an_unrecognised_version_is_not_trusted() {
        let store = temp_store("version");
        std::fs::create_dir_all(store.path().parent().unwrap()).expect("dir");
        std::fs::write(
            store.path(),
            r#"{"version":99,"records":[{"kind":"codex","enabled":true,"observedResetsAt":null,"rolledOver":false,"rolledOverAt":null,"lastPolledAt":null}]}"#,
        )
        .expect("write");
        assert!(!store.record(ProviderKind::Codex).enabled);
    }

    #[test]
    fn a_failed_save_is_reported_not_swallowed() {
        let dir = std::env::temp_dir().join("agentgauge-automation-blocked");
        let _ = fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let blocker = dir.join("automation.json");
        std::fs::create_dir_all(&blocker).expect("blocker");

        let result = AutomationStore::at(blocker).update(ProviderKind::Codex, |r| r);
        assert!(result.is_err(), "a failed save must be reported");
    }
}
