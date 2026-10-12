//! Persisted renderer preferences.
//!
//! The renderer owns the route vocabulary and everything it means; this module
//! only owns *durability* — that a choice survives a relaunch. Values are
//! stored as bounded strings and handed back verbatim, so a future renderer
//! change to the route set never needs a protocol change and a stale value from
//! an older build simply fails the renderer's own validation on read.
//!
//! State lives in the shared SQLite database, never in the renderer or in a
//! hand-rolled file: the same rule as onboarding, for the same reasons —
//! webview storage is not the app's, and the database gives the write
//! durability and the one-time import of a pre-database `settings.json`.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::shared::database::Database;
use crate::shared::error::Error;

/// The document key this store owns inside the shared database.
const KEY: &str = "uiState";

/// A renderer preference set.
///
/// Every field is optional: a missing document, a missing field, and "the user
/// never chose" are the same state. Adding a field later defaults old
/// documents rather than invalidating them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiState {
    /// The destination the renderer should reopen on, or none.
    ///
    /// Opaque here by design: the set of destinations belongs to the renderer's
    /// navigation model, and duplicating it in Rust would create a second list
    /// that can drift — the exact failure mode `OnboardingStep` already had
    /// when its two lists disagreed.
    pub last_route: Option<String>,
}

/// Largest accepted [`UiState::last_route`].
///
/// Routes are short fixed words; anything longer is not a route and must not
/// turn the store into a dumping ground.
const MAX_ROUTE_LEN: usize = 64;

impl UiState {
    /// Rejects a route value no renderer could have meant.
    ///
    /// The renderer re-validates on read as well — this bound is for storage,
    /// so a compromised renderer cannot persist unbounded strings.
    pub fn with_last_route(mut self, route: Option<String>) -> Self {
        self.last_route =
            route.filter(|value| !value.is_empty() && value.chars().count() <= MAX_ROUTE_LEN);
        self
    }
}

/// Reads and writes the renderer preferences.
#[derive(Clone)]
pub struct SettingsStore {
    db: Arc<Database>,
    legacy: Option<PathBuf>,
}

impl SettingsStore {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db, legacy: None }
    }

    /// Names the pre-database file to import on first sight, when one exists.
    pub fn with_legacy(mut self, path: Option<PathBuf>) -> Self {
        self.legacy = path;
        self
    }

    /// Reads the persisted state, defaulting to nothing chosen.
    ///
    /// A missing document is the normal first-run case, and an unreadable or
    /// corrupt one is treated the same way: a preference must never be able to
    /// block the app from launching.
    pub fn load(&self) -> UiState {
        if let Err(error) = self.db.import_doc(KEY, self.legacy.as_deref()) {
            eprintln!(
                "agentgauge: could not import saved preferences: {}",
                error.message
            );
        }

        let Ok(raw) = self.db.read_doc(KEY) else {
            return UiState::default();
        };

        raw.as_deref()
            .and_then(|raw| serde_json::from_str::<UiState>(raw).ok())
            .unwrap_or_default()
    }

    /// Persists the state.
    ///
    /// A failed write is reported, because a preference lost silently is a
    /// preference that lies about having been kept.
    pub fn save(&self, state: &UiState) -> Result<(), Error> {
        let encoded = serde_json::to_string(state)
            .map_err(|err| Error::storage(format!("Settings could not be encoded: {err}")))?;
        self.db.write_doc(KEY, &encoded)?;
        if let Err(error) = self.db.consume_doc(self.legacy.as_deref()) {
            eprintln!(
                "agentgauge: could not retire the old preferences store: {}",
                error.message
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn store(name: &str) -> (SettingsStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("agentgauge-settings-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("creates dir");
        let db = Database::open(&dir.join("agentgauge.db")).expect("opens");
        let legacy = dir.join("settings.json");
        (
            SettingsStore::new(Arc::new(db)).with_legacy(Some(legacy.clone())),
            legacy,
        )
    }

    #[test]
    fn a_missing_document_starts_with_nothing_chosen() {
        let (store, _) = store("missing");
        assert_eq!(store.load(), UiState { last_route: None });
    }

    #[test]
    fn a_chosen_route_survives_a_round_trip() {
        let (store, _) = store("round-trip");

        store
            .save(&UiState::default().with_last_route(Some("stats".into())))
            .expect("saves");

        assert_eq!(
            store.load(),
            UiState::default().with_last_route(Some("stats".into())),
        );
    }

    #[test]
    fn the_stored_document_stays_in_the_wire_shape() {
        // The field name is part of the wire contract with the renderer, so it
        // is pinned here in camelCase, not Rust case.
        let (store, _) = store("wire-shape");
        store
            .save(&UiState::default().with_last_route(Some("home".into())))
            .expect("saves");

        let raw = store.db.read_doc(KEY).expect("reads").expect("present");
        assert_eq!(raw, r#"{"lastRoute":"home"}"#);
    }

    #[test]
    fn an_older_document_with_a_removed_field_still_parses() {
        let (store, _) = store("old-settings");
        store
            .db
            .write_doc(KEY, r#"{"lastRoute":"stats","analyticsEnabled":false}"#)
            .expect("seeds");

        let state = store.load();

        assert_eq!(state.last_route.as_deref(), Some("stats"));
    }

    #[test]
    fn a_pre_database_file_is_imported_once() {
        let (store, legacy) = store("upgrade");
        fs::write(&legacy, r#"{"lastRoute":"automation"}"#).expect("seeds");

        assert_eq!(store.load().last_route.as_deref(), Some("automation"));
        assert!(!legacy.exists(), "the import must consume the file");
        assert_eq!(store.load().last_route.as_deref(), Some("automation"));
    }

    #[test]
    fn a_corrupt_document_falls_back_to_nothing_chosen() {
        let (store, _) = store("corrupt");
        store
            .db
            .write_doc(KEY, "{ not json")
            .expect("seeds a corrupt document");

        assert_eq!(store.load(), UiState::default());
    }

    #[test]
    fn a_route_longer_than_any_route_word_is_dropped() {
        let state = UiState::default().with_last_route(Some("x".repeat(MAX_ROUTE_LEN + 1)));
        assert_eq!(state.last_route, None, "unbounded strings must not persist");
    }

    #[test]
    fn an_empty_route_is_dropped() {
        let state = UiState::default().with_last_route(Some(String::new()));
        assert_eq!(state.last_route, None);
    }

    #[test]
    fn a_bounded_route_is_kept_verbatim() {
        // Case and spelling are the renderer's business, not ours.
        let state = UiState::default().with_last_route(Some("Stats".into()));
        assert_eq!(state.last_route.as_deref(), Some("Stats"));
    }

    #[test]
    fn a_failed_save_is_reported_not_swallowed() {
        let dir = std::env::temp_dir().join("agentgauge-settings-readonly");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("creates dir");
        let path = dir.join("agentgauge.db");
        {
            let db = Database::open(&path).expect("creates the schema");
            db.write_doc(KEY, r#"{"lastRoute":null}"#).expect("seeds");
        }
        let conn = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("opens read-only");
        let store = SettingsStore::new(Arc::new(Database::from_connection(conn).expect("wraps")));

        let result = store.save(&UiState::default());
        assert!(result.is_err(), "a failed save must be reported");
    }
}
