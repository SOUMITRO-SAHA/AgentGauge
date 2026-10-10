// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
//!
//! Composition root. Owns plugin registration, managed-state construction and
//! the command list — and nothing else. Every behaviour lives in a module under
//! `src/modules/**`; introducing a module means adding its `mod` line here and
//! naming its commands in `generate_handler!`, which is the only edit this file
//! should ever need.

mod modules;
mod shared;

use std::sync::Arc;

use tauri::Manager;

use modules::automation::AutomationRunner;
use modules::commands::AppState;
use modules::onboarding::OnboardingStore;
use modules::providers::ProviderRegistry;
use modules::settings::SettingsStore;
use modules::widget::SnapshotStore;
use shared::clock::{Clock, SystemClock};

/// Surfaces for the integration tests in `tests/`.
///
/// The transport and the decoders are private to their modules by design, so
/// this re-exports exactly what an out-of-line test needs — and nothing that a
/// production caller should reach for.
#[cfg(any(test, feature = "testkit"))]
pub mod testkit {
    pub use crate::modules::providers::codex::protocol::decode_rate_limits;
    pub use crate::modules::providers::codex::transport::AppServer;
    pub use crate::shared::domain::ProviderKind;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let now_ms = SystemClock.now_ms();
    // Built once here and shared: the watcher and the command dispatcher must
    // see the same provider instances, or a poll and a manual read could each
    // spawn their own app-server process.
    let registry = Arc::new(ProviderRegistry::new(now_ms));
    let automation = Arc::new(AutomationRunner::new(Arc::clone(&registry)));
    // Where the macOS system widget reads its snapshot from. `None` only when
    // there is no home directory, in which case the widget has nowhere to read
    // either and the setup guide says so.
    let widget_snapshots = SnapshotStore::from_env();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            // The app-data directory is resolved here, once, and handed to the
            // module that owns persistence. No module reaches for a global.
            let onboarding = match app.path().app_data_dir() {
                Ok(dir) => OnboardingStore::in_app_dir(&dir),
                // Without a writable app-data directory onboarding simply does
                // not persist; the app still runs.
                Err(_) => {
                    OnboardingStore::new(std::env::temp_dir().join("ism").join("onboarding.json"))
                }
            };

            // Same rule for preferences: degrade to a throwaway directory
            // rather than fail to launch.
            let settings = match app.path().app_data_dir() {
                Ok(dir) => SettingsStore::in_app_dir(&dir),
                Err(_) => {
                    SettingsStore::new(std::env::temp_dir().join("ism").join("settings.json"))
                }
            };

            app.manage(AppState {
                registry,
                automation,
                onboarding,
                widget_snapshots,
                settings,
            });
            Ok(())
        })
        // One command implements the whole request/response protocol defined in
        // `shared::protocol`, so this list never grows per feature.
        .invoke_handler(tauri::generate_handler![modules::commands::dispatch]);

    // E2E testing plugins. Debug builds only, so they never ship in release.
    #[cfg(debug_assertions)]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
