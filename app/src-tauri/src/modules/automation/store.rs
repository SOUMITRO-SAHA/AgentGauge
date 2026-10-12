//! Persisted automation choices and observed rollover state.
//!
//! Starting a sub's rollover monitor is a *choice*: it is written here the
//! moment it is made, and the runner re-reads this store at every launch, so a
//! sub the user enabled is running again before the first frame renders — the
//! Start button is an instruction, not a per-session ritual.
//!
//! The store keeps the choice *and* the observed rollover state, so the screen
//! restores continuity (baseline reset, an unacknowledged rollover, the last
//! check) instead of blanks. Volatile schedule fields (`nextPollAt`) are never
//! persisted; they are recomputed the moment the monitor resumes.
//!
//! Durability contract, the same one the other stores keep: versioned (an
//! unrecognised version is not trusted), transactional (a per-record update is
//! one atomic read-modify-write, so a poll tick and a user's toggle can never
//! lose each other's write), and corrupt-safe (a store that cannot be
//! understood defaults to all-off rather than being guessed at). A
//! pre-database `automation.json` is imported once, like every other store.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::shared::database::Database;
use crate::shared::domain::ProviderKind;
use crate::shared::error::Error;

/// The document key this store owns inside the shared database.
const KEY: &str = "automation";

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
#[derive(Clone)]
pub struct AutomationStore {
    db: Arc<Database>,
    legacy: Option<PathBuf>,
}

impl AutomationStore {
    /// Builds a store over the shared database.
    pub fn new(db: Arc<Database>) -> Self {
        Self { db, legacy: None }
    }

    /// Names the pre-database file to import on first sight, when one exists.
    pub fn with_legacy(mut self, path: Option<PathBuf>) -> Self {
        self.legacy = path;
        self
    }

    /// Reads the config, defaulting to all-opted-out.
    ///
    /// A missing document is the normal first-run case; a corrupt document or
    /// an unrecognised version is treated the same way, because a config that
    /// cannot be understood must never be guessed at.
    pub fn load(&self) -> AutomationConfig {
        if let Err(error) = self.db.import_doc(KEY, self.legacy.as_deref()) {
            log::warn!("could not import automation choices: {}", error.message);
        }
        self.decode(self.db.read_doc(KEY).ok().flatten())
    }

    /// The record for `kind`, inserting the default when the store has never
    /// mentioned it.
    pub fn record(&self, kind: ProviderKind) -> AutomationRecord {
        self.load()
            .records
            .into_iter()
            .find(|record| record.kind == kind)
            .unwrap_or_else(|| AutomationRecord::new(kind))
    }

    /// Applies `change` to one record and persists the result.
    ///
    /// The read, the change, and the write are one database operation, so a
    /// poll tick persisting an observed reset cannot interleave with the
    /// renderer toggling a switch and lose either write.
    pub fn update(
        &self,
        kind: ProviderKind,
        change: impl FnOnce(AutomationRecord) -> AutomationRecord,
    ) -> Result<AutomationRecord, Error> {
        let updated = self.db.update_doc(KEY, |stored| {
            let mut config = self.decode(stored);
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
            let encoded = serde_json::to_string(&config).map_err(|err| {
                Error::storage(format!("The automation config could not be encoded: {err}"))
            })?;
            Ok((updated, encoded))
        })?;
        if let Err(error) = self.db.consume_doc(self.legacy.as_deref()) {
            log::warn!(
                "could not retire the old automation store: {}",
                error.message
            );
        }
        Ok(updated)
    }

    /// Decodes a stored document, defaulting to all-off when it cannot be
    /// understood — including an unrecognised version.
    fn decode(&self, stored: Option<String>) -> AutomationConfig {
        stored
            .as_deref()
            .and_then(|raw| serde_json::from_str::<AutomationConfig>(raw).ok())
            .filter(|config| config.version == AUTOMATION_CONFIG_VERSION)
            .unwrap_or_else(AutomationConfig::default_with_all_kinds)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(name: &str) -> (AutomationStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("agentgauge-automation-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("creates dir");
        let db = Database::open(&dir.join("agentgauge.db")).expect("opens");
        let legacy = dir.join("automation.json");
        (
            AutomationStore::new(Arc::new(db)).with_legacy(Some(legacy.clone())),
            legacy,
        )
    }

    fn readonly_store(name: &str) -> AutomationStore {
        let dir = std::env::temp_dir().join(format!("agentgauge-automation-readonly-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("creates dir");
        let path = dir.join("agentgauge.db");
        {
            let db = Database::open(&path).expect("creates the schema");
            db.write_doc(KEY, r#"{"version":1,"records":[]}"#)
                .expect("seeds");
        }
        let conn = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("opens read-only");
        AutomationStore::new(Arc::new(Database::from_connection(conn).expect("wraps")))
    }

    #[test]
    fn a_missing_document_starts_all_opted_out() {
        let (store, _) = store("missing");
        let config = store.load();
        assert_eq!(config.records.len(), 4);
        assert!(config.records.iter().all(|record| !record.enabled));
    }

    #[test]
    fn the_choice_survives_a_round_trip_in_the_wire_shape() {
        let (store, _) = store("round-trip");
        store
            .update(ProviderKind::Zai, |mut record| {
                record.enabled = true;
                record.observed_resets_at = Some(5_000);
                record
            })
            .expect("saves");

        let raw = store
            .db
            .read_doc(KEY)
            .expect("reads")
            .expect("the document exists");
        assert!(
            raw.contains("\"enabled\":true"),
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
    fn update_inserts_a_record_the_store_never_had() {
        let (store, _) = store("upsert");
        store
            .db
            .write_doc(
                KEY,
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
    fn a_pre_database_file_is_imported_once() {
        let (store, legacy) = store("upgrade");
        std::fs::write(
            &legacy,
            r#"{"version":1,"records":[{"kind":"codex","enabled":true,"observedResetsAt":null,"rolledOver":false,"rolledOverAt":null,"lastPolledAt":null}]}"#,
        )
        .expect("seeds");

        assert!(store.record(ProviderKind::Codex).enabled);
        assert!(!legacy.exists(), "the import must consume the file");
        assert!(store.record(ProviderKind::Codex).enabled);
    }

    #[test]
    fn a_corrupt_document_falls_back_to_opted_out() {
        let (store, _) = store("corrupt");
        store
            .db
            .write_doc(KEY, "{ not json")
            .expect("seeds a corrupt document");
        assert!(!store.load().records.iter().any(|r| r.enabled));
    }

    #[test]
    fn an_unrecognised_version_is_not_trusted() {
        let (store, _) = store("version");
        store
            .db
            .write_doc(
                KEY,
                r#"{"version":99,"records":[{"kind":"codex","enabled":true,"observedResetsAt":null,"rolledOver":false,"rolledOverAt":null,"lastPolledAt":null}]}"#,
            )
            .expect("writes");
        assert!(!store.record(ProviderKind::Codex).enabled);
    }

    #[test]
    fn a_failed_save_is_reported_not_swallowed() {
        let store = readonly_store("blocked");
        let result = AutomationStore::update(&store, ProviderKind::Codex, |r| r);
        assert!(result.is_err(), "a failed save must be reported");
    }
}
