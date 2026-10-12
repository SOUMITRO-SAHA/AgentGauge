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
use modules::automation::AutomationStore;
use modules::commands::AppState;
use modules::kickoff::KickoffStore;
use modules::onboarding::OnboardingStore;
use modules::providers::ProviderRegistry;
use modules::settings::SettingsStore;
use modules::widget::SnapshotStore;
use shared::database::Database;

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

/// Where the durable stores live.
///
/// Defaults to the OS application-data directory for the app's identifier.
/// A debug build honours `AGENTGAUGE_DATA_DIR` instead, which gives the e2e
/// suite a disposable sandbox: the harness seeds and resets that directory
/// freely, and the user's real profile is never touched by a test run.
/// Release builds ignore the variable — production storage is never
/// redirectable by the environment.
fn resolve_data_dir(app: &tauri::App) -> Option<std::path::PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("AGENTGAUGE_DATA_DIR") {
        if !dir.is_empty() {
            return Some(std::path::PathBuf::from(dir));
        }
    }

    app.path().app_data_dir().ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The headless kickoff worker: the system scheduler starts this same
    // binary with the `kickoff-worker` argument once a minute, with no app
    // window, no Tauri runtime, and no renderer. It must be decided before
    // anything Tauri is built — a worker tick must never open the UI.
    if std::env::args().nth(1).as_deref() == Some("kickoff-worker") {
        std::process::exit(run_kickoff_worker());
    }

    // Built once here and shared: the watcher and the command dispatcher must
    // see the same provider instances, or a poll and a manual read could each
    // spawn their own app-server process.
    let registry = Arc::new(ProviderRegistry::new());
    // Where the macOS system widget reads its snapshot from. `None` only when
    // there is no home directory, in which case the widget has nowhere to read
    // either and the setup guide says so.
    let widget_snapshots = SnapshotStore::from_env();
    // The kickoff schedule lives beside the widget snapshot: the headless
    // worker reads the same file without this app running. Shared with the
    // automation reading hook, which folds fresh reset times in.
    let kickoff_shared = KickoffStore::from_env().map(Arc::new);

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .setup(move |app| {
            // Where every durable store lives: the app-data directory,
            // resolved once here and handed to the modules that own
            // persistence. No module reaches for a global. Debug builds may
            // redirect it (the e2e harness runs against a sandbox so a test
            // run can never touch the real profile); release builds ignore
            // the variable.
            let data_dir = resolve_data_dir(app);

            // One database behind every persisted store. Without a usable
            // data directory the app degrades to an in-memory database — it
            // still runs; persistence simply does not outlive the process,
            // the same contract the old throwaway-directory fallback kept.
            let database = match data_dir
                .as_deref()
                .map(|dir| Database::open(&dir.join("agentgauge.db")))
            {
                Some(Ok(db)) => Arc::new(db),
                other => {
                    if let Some(Err(error)) = other {
                        eprintln!(
                            "agentgauge: falling back to in-memory storage: {}",
                            error.message
                        );
                    }
                    Arc::new(Database::open_in_memory().expect("an in-memory database"))
                }
            };

            // Each store imports its pre-database file exactly once, so an
            // upgraded install keeps its progress: a user who already finished
            // onboarding must never see the flow restart.
            let onboarding = OnboardingStore::new(Arc::clone(&database))
                .with_legacy(data_dir.clone().map(|dir| dir.join("onboarding.json")));
            let settings = SettingsStore::new(Arc::clone(&database))
                .with_legacy(data_dir.clone().map(|dir| dir.join("settings.json")));

            // The automation runner owns its persisted per-sub choices: the
            // same durability rule as preferences, and the same fallback.
            let automation = {
                let store = AutomationStore::new(Arc::clone(&database))
                    .with_legacy(data_dir.clone().map(|dir| dir.join("automation.json")));
                let mut runner = AutomationRunner::new(Arc::clone(&registry)).with_store(store);
                // Every monitor reading also feeds the kickoff schedule, so
                // its worker stays on the freshest window boundary without
                // polling providers itself.
                if let Some(kickoff) = kickoff_shared.clone() {
                    runner = runner.with_on_reading(Arc::new(move |kind, resets_at| {
                        if let Some(secs) = resets_at {
                            let now = crate::shared::clock::Clock::now_ms(
                                &crate::shared::clock::SystemClock,
                            );
                            let _ = kickoff.update(kind, |mut sub| {
                                sub.apply_reset(secs, now);
                                sub
                            });
                        }
                    }));
                }
                // The persisted choices run again before the first frame
                // renders.
                runner.resume_persisted();
                Arc::new(runner)
            };

            let app_registry = Arc::clone(&registry);
            let has_kickoff_store = kickoff_shared.is_some();

            // Behind an `Arc` because a dispatch runs its blocking read on
            // another thread: the command hands that read an owned handle
            // rather than a borrow, so nothing is held across the boundary.
            app.manage(Arc::new(AppState {
                registry,
                automation,
                onboarding,
                widget_snapshots,
                settings,
                kickoff: kickoff_shared,
                app_data: data_dir,
            }));

            // While the app is open it runs the kickoff tick itself, so a
            // subscription is never silently unscheduled just because the
            // system agent is missing or between launches. The system agent
            // (installed on opt-in) carries the same tick when the app is
            // closed; the two share one schedule file, and a near-simultaneous
            // double fire costs one extra trivial prompt, never a wrong
            // schedule — each executor re-anchors the same window.
            if has_kickoff_store {
                let registry = app_registry;
                std::thread::Builder::new()
                    .name("agentgauge-kickoff".to_string())
                    .spawn(move || {
                        let kick = |kind: crate::shared::domain::ProviderKind,
                                    prompt: &str,
                                    model: Option<&str>,
                                    effort: Option<&str>| {
                            registry.kickoff(kind, prompt, model, effort)
                        };
                        loop {
                            std::thread::sleep(std::time::Duration::from_secs(30));
                            let Some(store) = KickoffStore::from_env() else {
                                return;
                            };
                            let now = crate::shared::clock::Clock::now_ms(
                                &crate::shared::clock::SystemClock,
                            );
                            if let Err(error) = modules::kickoff::worker::tick(&store, now, &kick) {
                                eprintln!("agentgauge: kickoff tick failed: {}", error.message);
                            }
                        }
                    })
                    .ok();
            }
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

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // The Dock tile is only ours to set once the run loop is up. Setting it
    // during `setup` is too early — macOS builds the tile when the app becomes
    // ready and overwrites anything set before that.
    app.run(|_handle, event| {
        if let tauri::RunEvent::Ready = event {
            #[cfg(all(target_os = "macos", debug_assertions))]
            modules::app_icon::install();
        }
    });
}

/// One headless kickoff tick, from the system scheduler.
///
/// Exit code 0 covers every tick that did its job — including "nothing was
/// due" and "a provider refused this attempt", both of which are recorded in
/// the schedule file for the UI to show. Only a tick that could not do its
/// job at all (unreadable schedule) exits non-zero, so launchd's own logging
/// stays meaningful.
fn run_kickoff_worker() -> i32 {
    let Some(store) = KickoffStore::from_env() else {
        eprintln!("agentgauge: no home directory; the kickoff worker cannot run.");
        return 0;
    };

    let registry = ProviderRegistry::new();
    let now = crate::shared::clock::Clock::now_ms(&crate::shared::clock::SystemClock);
    let kick =
        |kind: crate::shared::domain::ProviderKind,
         prompt: &str,
         model: Option<&str>,
         effort: Option<&str>| { registry.kickoff(kind, prompt, model, effort) };

    match modules::kickoff::worker::tick(&store, now, &kick) {
        Ok(fired) => {
            if fired > 0 {
                eprintln!("agentgauge: kickoff worker fired {fired} attempt(s).");
            }
            0
        }
        Err(error) => {
            eprintln!("agentgauge: kickoff worker failed: {}", error.message);
            1
        }
    }
}
