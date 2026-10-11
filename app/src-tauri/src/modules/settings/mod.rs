//! Persisted renderer preferences.
//!
//! The renderer owns the route vocabulary and everything it means; this module
//! only owns *durability* — that a choice survives a relaunch. Values are
//! stored as bounded strings and handed back verbatim, so a future renderer
//! change to the route set never needs a protocol change and a stale value from
//! an older build simply fails the renderer's own validation on read.
//!
//! State lives in the OS application-data directory, never in the renderer:
//! the same rule as onboarding, for the same reason — webview storage is not
//! the app's and does not survive a cleared webview data directory.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::shared::error::Error;

/// A renderer preference set.
///
/// Every field is optional: a missing file, a missing field, and "the user
/// never chose" are the same state. Adding a field later defaults old files
/// rather than invalidating them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

impl Default for UiState {
    fn default() -> Self {
        Self { last_route: None }
    }
}

/// Largest accepted [`UiState::last_route`].
///
/// Routes are short fixed words; anything longer is not a route and must not
/// turn the file into a dumping ground.
const MAX_ROUTE_LEN: usize = 64;

impl UiState {
    /// Rejects a route value no renderer could have meant.
    ///
    /// The renderer re-validates on read as well — this bound is for the file,
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
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// A store rooted in the OS application-data directory.
    pub fn in_app_dir(app_data: &std::path::Path) -> Self {
        Self::new(app_data.join("settings.json"))
    }

    /// Reads the persisted state, defaulting to nothing chosen.
    ///
    /// A missing file is the normal first-run case, and an unreadable or
    /// corrupt one is treated the same way: a preference must never be able to
    /// block the app from launching.
    pub fn load(&self) -> UiState {
        let Ok(raw) = fs::read_to_string(&self.path) else {
            return UiState::default();
        };

        let Ok(parsed) = serde_json::from_str::<UiState>(&raw) else {
            return UiState::default();
        };

        parsed
    }

    /// Persists the state, creating the parent directory if needed.
    ///
    /// Written through a sibling temp file and renamed, so a reader — the next
    /// launch — never sees a half-written file, matching the widget snapshot.
    pub fn save(&self, state: &UiState) -> Result<(), Error> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|err| {
                Error::storage(format!("Could not create the app data directory: {err}"))
            })?;
        }

        let encoded = serde_json::to_string_pretty(state)
            .map_err(|err| Error::storage(format!("Settings could not be encoded: {err}")))?;

        let temp = Self::temp_path(&self.path);
        fs::write(&temp, encoded)
            .map_err(|err| Error::storage(format!("Settings could not be saved: {err}")))?;
        fs::rename(&temp, &self.path).map_err(|err| {
            let _ = fs::remove_file(&temp);
            Error::storage(format!("Settings could not be saved: {err}"))
        })
    }

    fn temp_path(path: &std::path::Path) -> PathBuf {
        path.with_extension("json.tmp")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("agentgauge-settings-{name}"));
        let _ = fs::remove_dir_all(&dir);
        dir.join("nested").join("settings.json")
    }

    #[test]
    fn a_missing_file_starts_with_nothing_chosen() {
        let store = SettingsStore::new(temp_path("missing"));
        assert_eq!(store.load(), UiState { last_route: None });
    }

    #[test]
    fn a_chosen_route_survives_a_round_trip() {
        let path = temp_path("round-trip");
        let store = SettingsStore::new(path.clone());

        store
            .save(&UiState::default().with_last_route(Some("stats".into())))
            .expect("saves");

        assert_eq!(
            SettingsStore::new(path).load(),
            UiState::default().with_last_route(Some("stats".into())),
        );
    }

    #[test]
    fn the_file_is_json_the_way_the_renderer_wrote_it() {
        // The field name is part of the wire contract with the renderer, so it
        // is pinned here in camelCase, not Rust case.
        let path = temp_path("wire-shape");
        SettingsStore::new(path.clone())
            .save(&UiState::default().with_last_route(Some("home".into())))
            .expect("saves");

        let raw = fs::read_to_string(path).expect("reads");
        assert_eq!(
            raw.trim(),
            "{\n  \"lastRoute\": \"home\"\n}",
            "settings.json must stay in the wire shape"
        );
    }

    #[test]
    fn an_older_file_with_a_removed_field_still_parses() {
        let path = temp_path("old-settings");
        std::fs::create_dir_all(path.parent().unwrap()).expect("dir");
        std::fs::write(&path, r#"{"lastRoute":"stats","analyticsEnabled":false}"#).expect("write");

        let state = SettingsStore::new(path).load();

        assert_eq!(state.last_route.as_deref(), Some("stats"));
    }

    #[test]
    fn a_corrupt_file_falls_back_to_nothing_chosen() {
        let path = temp_path("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).expect("dir");
        std::fs::write(&path, "{ not json").expect("writes");

        assert_eq!(SettingsStore::new(path).load(), UiState::default());
    }

    #[test]
    fn creates_missing_parent_directories() {
        // temp_path nests two levels that do not exist yet.
        let store = SettingsStore::new(temp_path("mkdir"));
        store
            .save(&UiState::default())
            .expect("creates parents and saves");
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
    fn a_save_into_a_blocked_path_is_reported_not_swallowed() {
        let dir = std::env::temp_dir().join("agentgauge-settings-blocked");
        let _ = fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        // A directory where the file must go makes every write fail.
        let path = dir.join("settings.json");
        std::fs::create_dir_all(&path).expect("blocker");

        let result = SettingsStore::new(path).save(&UiState::default());
        assert!(result.is_err(), "a failed save must be reported");
    }
}
