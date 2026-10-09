//! Onboarding progress.
//!
//! The flow demonstrates what the app does rather than gating access behind an
//! account, so there is no auth here by design. What must persist is *where the
//! user got to*, so "skip" resumes in the right place instead of restarting.
//!
//! State lives in the OS application-data directory, never in the renderer.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::shared::error::Error;

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
    /// file cannot strand the user past the end.
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
pub struct OnboardingStore {
    path: PathBuf,
}

impl OnboardingStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// A store rooted in the OS application-data directory.
    pub fn in_app_dir(app_data: &std::path::Path) -> Self {
        Self::new(app_data.join("onboarding.json"))
    }

    /// Reads the persisted state, defaulting to a fresh start.
    ///
    /// A missing file is the normal first-run case. An unreadable or corrupt
    /// one also defaults rather than failing: onboarding must never be able to
    /// block the app from launching.
    pub fn load(&self) -> OnboardingState {
        let Ok(raw) = fs::read_to_string(&self.path) else {
            return OnboardingState {
                step: OnboardingStep::Welcome,
                dismissed: false,
            };
        };

        #[derive(Deserialize)]
        struct Persisted {
            step: Option<String>,
            dismissed: Option<bool>,
        }

        let Ok(parsed) = serde_json::from_str::<Persisted>(&raw) else {
            return OnboardingState {
                step: OnboardingStep::Welcome,
                dismissed: false,
            };
        };

        OnboardingState {
            step: parsed
                .step
                .as_deref()
                .map(OnboardingStep::from_wire)
                .unwrap_or(OnboardingStep::Welcome),
            dismissed: parsed.dismissed.unwrap_or(false),
        }
    }

    /// Persists the state, creating the parent directory if needed.
    pub fn save(&self, state: &OnboardingState) -> Result<(), Error> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|err| {
                Error::storage(format!("Could not create the app data directory: {err}"))
            })?;
        }

        let encoded = serde_json::to_string_pretty(state).map_err(|err| {
            Error::storage(format!("Onboarding state could not be encoded: {err}"))
        })?;

        fs::write(&self.path, encoded)
            .map_err(|err| Error::storage(format!("Onboarding state could not be saved: {err}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ism-onboarding-{name}"));
        let _ = fs::remove_dir_all(&dir);
        dir.join("nested").join("onboarding.json")
    }

    #[test]
    fn a_missing_file_starts_at_welcome() {
        let store = OnboardingStore::new(temp_path("missing"));
        let state = store.load();
        assert_eq!(state.step, OnboardingStep::Welcome);
        assert!(!state.dismissed);
    }

    #[test]
    fn saves_and_reloads_a_step() {
        let store = OnboardingStore::new(temp_path("roundtrip"));
        let state = OnboardingState {
            step: OnboardingStep::WindowRollover,
            dismissed: false,
        };
        store.save(&state).expect("saves");
        assert_eq!(store.load(), state);
    }

    #[test]
    fn creates_missing_parent_directories() {
        let path = temp_path("creates");
        assert!(!path.parent().expect("has parent").exists());
        let store = OnboardingStore::new(path.clone());
        store
            .save(&OnboardingState {
                step: OnboardingStep::Automation,
                dismissed: false,
            })
            .expect("saves");
        assert!(path.exists());
    }

    #[test]
    fn a_corrupt_file_falls_back_to_the_start() {
        // Onboarding must never be able to block launch.
        let path = temp_path("corrupt");
        write_raw(&path, "{ not json");
        let state = OnboardingStore::new(path).load();
        assert_eq!(state.step, OnboardingStep::Welcome);
    }

    #[test]
    fn an_unknown_step_string_falls_back_to_the_start() {
        let path = temp_path("unknown-step");
        write_raw(&path, r#"{"step":"teleport","dismissed":true}"#);
        let state = OnboardingStore::new(path).load();
        assert_eq!(state.step, OnboardingStep::Welcome);
        assert!(state.dismissed, "other fields still load");
    }

    #[test]
    fn an_unreadable_path_degrades_instead_of_failing() {
        // A path whose ancestor is a regular file can never exist. Reading must
        // still yield a usable state rather than blocking launch.
        let dir = temp_path("blocked-parent");
        let parent = dir.parent().expect("has parent");
        fs::create_dir_all(parent).expect("creates dir");
        fs::write(&dir, "a file, not a directory").expect("writes a file");

        let state = OnboardingStore::new(dir.join("onboarding.json")).load();
        assert_eq!(state.step, OnboardingStep::Welcome);
    }

    #[test]
    fn a_save_into_a_blocked_path_is_reported_not_swallowed() {
        // Losing progress silently would send the user through the whole flow
        // again, so a failed write must surface as an error.
        let dir = temp_path("blocked-save");
        let parent = dir.parent().expect("has parent");
        fs::create_dir_all(parent).expect("creates dir");
        fs::write(&dir, "a file, not a directory").expect("writes a file");

        let err = OnboardingStore::new(dir.join("onboarding.json")).save(&OnboardingState {
            step: OnboardingStep::Done,
            dismissed: false,
        });
        assert!(err.is_err(), "a blocked write must be reported");
    }

    fn write_raw(path: &std::path::Path, contents: &str) {
        fs::create_dir_all(path.parent().expect("has parent")).expect("creates dir");
        fs::write(path, contents).expect("writes");
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
        let store = OnboardingStore::new(temp_path("dismissed"));
        let state = OnboardingState {
            step: OnboardingStep::Widget,
            dismissed: true,
        };
        store.save(&state).expect("saves");
        assert!(store.load().dismissed);
    }
}
