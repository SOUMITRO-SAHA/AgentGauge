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
use modules::permissions::VolumeAccessStore;
use modules::providers::ProviderRegistry;
use modules::settings::SettingsStore;
use modules::widget::process_widget_refresh;
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

fn is_service_running() -> bool {
    #[cfg(target_os = "macos")]
    {
        let home = match std::env::var_os("HOME") {
            Some(h) => h,
            None => return false,
        };
        let lock_suffix = if cfg!(debug_assertions) { "-dev" } else { "" };
        let lock_path = shared::app_support::app_support_dir(&home)
            .join(format!("background-service{lock_suffix}.lock"));
        let Ok(file) = std::fs::OpenOptions::new().write(true).open(&lock_path) else {
            return false;
        };
        use std::os::fd::AsRawFd;
        // SAFETY: Nonblocking exclusive lock attempt — if it succeeds the
        // service is NOT running (no one else holds the lock).
        let got_lock = unsafe { libc_flock(file.as_raw_fd(), 2 | 4) } == 0;
        if got_lock {
            let _ = unsafe { libc_flock(file.as_raw_fd(), 8) };
            false
        } else {
            true
        }
    }
    #[cfg(not(target_os = "macos"))]
    false
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    #[link_name = "flock"]
    fn libc_flock(fd: i32, operation: i32) -> i32;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if std::env::args().nth(1).as_deref() == Some("background-service") {
        if let Some(home) = std::env::var_os("HOME") {
            if let Some(dir) = shared::logging::app_log_dir_from_home(&home) {
                let _ = shared::logging::init(Arc::new(shared::clock::SystemClock), dir);
            }
        }
        std::process::exit(run_background_service());
    }
    // The headless kickoff worker: the system scheduler starts this same
    // binary with the `kickoff-worker` argument once a minute, with no app
    // window, no Tauri runtime, and no renderer. It must be decided before
    // anything Tauri is built — a worker tick must never open the UI.
    if std::env::args().nth(1).as_deref() == Some("kickoff-worker") {
        if modules::background::agent::is_installed() && is_service_running() {
            return;
        }
        if let Some(home) = std::env::var_os("HOME") {
            if let Some(dir) = shared::logging::app_log_dir_from_home(&home) {
                let _ = shared::logging::init(Arc::new(shared::clock::SystemClock), dir);
            }
        }
        std::process::exit(run_kickoff_worker(&ProviderRegistry::new()));
    }
    if std::env::args().nth(1).as_deref() == Some("widget-refresh-worker") {
        if modules::background::agent::is_installed() && is_service_running() {
            return;
        }
        std::process::exit(process_widget_refresh(&ProviderRegistry::new()));
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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            if let Ok(executable) = std::env::current_exe() {
                if let Err(error) = modules::background::agent::install(&executable) {
                    log::warn!("background service registration failed: {}", error.message);
                }
            }
            // Where every durable store lives: the app-data directory,
            // resolved once here and handed to the modules that own
            // persistence. No module reaches for a global. Debug builds may
            // redirect it (the e2e harness runs against a sandbox so a test
            // run can never touch the real profile); release builds ignore
            // the variable.
            let data_dir = resolve_data_dir(app);

            if let Some(dir) = data_dir.as_deref() {
                let _ =
                    shared::logging::init(Arc::new(shared::clock::SystemClock), dir.join("logs"));
            }

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
                        log::warn!("falling back to in-memory storage: {}", error.message);
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
            let volume_access = VolumeAccessStore::new(Arc::clone(&database));

            // The automation runner owns its persisted per-sub choices: the
            // same durability rule as preferences, and the same fallback.
            let automation = {
                let store = AutomationStore::new(Arc::clone(&database))
                    .with_legacy(data_dir.clone().map(|dir| dir.join("automation.json")));
                let mut runner = AutomationRunner::new(Arc::clone(&registry))
                    .with_store(store)
                    .with_external_service();
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
                Arc::new(runner)
            };

            // Behind an `Arc` because a dispatch runs its blocking read on
            // another thread: the command hands that read an owned handle
            // rather than a borrow, so nothing is held across the boundary.
            app.manage(Arc::new(AppState {
                registry,
                automation,
                onboarding,
                widget_snapshots,
                settings,
                volume_access,
                kickoff: kickoff_shared,
                app_version: app.package_info().version.to_string(),
            }));

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
    app.run(|handle, event| match event {
        tauri::RunEvent::Ready => {
            #[cfg(all(target_os = "macos", debug_assertions))]
            modules::app_icon::install();
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { .. },
            ..
        } if label == "main" => handle.exit(0),
        _ => {}
    });
}

/// One headless kickoff tick, from the system scheduler.
///
/// Exit code 0 covers every tick that did its job — including "nothing was
/// due" and "a provider refused this attempt", both of which are recorded in
/// the schedule file for the UI to show. Only a tick that could not do its
/// job at all (unreadable schedule) exits non-zero, so launchd's own logging
/// stays meaningful.
fn run_kickoff_worker(registry: &ProviderRegistry) -> i32 {
    let Some(store) = KickoffStore::from_env() else {
        log::warn!("no home directory; the kickoff worker cannot run.");
        return 0;
    };

    let now = crate::shared::clock::Clock::now_ms(&crate::shared::clock::SystemClock);
    let kick = |kind: crate::shared::domain::ProviderKind,
                prompt: &str,
                model: Option<&str>,
                effort: Option<&str>| {
        log::info!(
            "kickoff: sending to {kind:?} model={} effort={}",
            model.unwrap_or("default"),
            effort.unwrap_or("none"),
        );
        let result = registry.kickoff(kind, prompt, model, effort);
        match &result {
            Ok(outcome) if outcome.accepted => {
                log::info!(
                    "kickoff: {kind:?} accepted, reply={:?}",
                    outcome.reply.chars().take(80).collect::<String>(),
                );
            }
            Ok(outcome) => {
                log::warn!(
                    "kickoff: {kind:?} refused: {}",
                    outcome.reason.as_deref().unwrap_or("unknown"),
                );
            }
            Err(error) => {
                log::error!("kickoff: {kind:?} error: {}", error.message);
            }
        }
        result
    };

    match modules::kickoff::worker::tick(&store, now, &kick) {
        Ok(fired) => {
            if fired > 0 {
                log::info!("kickoff worker completed, fired {fired} attempt(s).");
            }
            0
        }
        Err(error) => {
            log::error!("kickoff worker failed: {}", error.message);
            1
        }
    }
}

fn run_background_service() -> i32 {
    #[cfg(target_os = "macos")]
    let Some(_lock) = modules::background::claim_service() else {
        return 0;
    };
    #[cfg(not(target_os = "macos"))]
    return 1;

    #[cfg(target_os = "macos")]
    {
        let registry = Arc::new(ProviderRegistry::new());
        let kickoff = KickoffStore::from_env().map(Arc::new);
        let automation = std::env::var_os("HOME")
            .map(|home| shared::app_support::app_support_dir(&home))
            .and_then(|dir| {
                Database::open(&dir.join("agentgauge.db"))
                    .ok()
                    .map(|db| (dir, db))
            })
            .map(|(dir, db)| {
                let mut runner = AutomationRunner::new(Arc::clone(&registry)).with_store(
                    AutomationStore::new(Arc::new(db))
                        .with_legacy(Some(dir.join("automation.json"))),
                );
                if let Some(schedule) = kickoff.clone() {
                    runner = runner.with_on_reading(Arc::new(move |kind, resets_at| {
                        if let Some(secs) = resets_at {
                            let now = crate::shared::clock::Clock::now_ms(
                                &crate::shared::clock::SystemClock,
                            );
                            let _ = schedule.update(kind, |mut sub| {
                                sub.apply_reset(secs, now);
                                sub
                            });
                        }
                    }));
                }
                runner
            });
        let mut widget_backoff = false;
        let mut next_tick = std::time::Instant::now();
        loop {
            if !widget_backoff {
                let code = process_widget_refresh(&registry);
                if code != 0 {
                    log::warn!("widget refresh returned {code}; backing off until next tick");
                    widget_backoff = true;
                }
            }
            if std::time::Instant::now() >= next_tick {
                widget_backoff = false;
                if let Some(runner) = &automation {
                    runner.poll_enabled_due();
                }
                if let Some(schedule) = &kickoff {
                    let now =
                        crate::shared::clock::Clock::now_ms(&crate::shared::clock::SystemClock);
                    let kick = |kind: crate::shared::domain::ProviderKind,
                                prompt: &str,
                                model: Option<&str>,
                                effort: Option<&str>| {
                        registry.kickoff(kind, prompt, model, effort)
                    };
                    if let Err(error) = modules::kickoff::worker::tick(schedule, now, &kick) {
                        log::error!("background kickoff tick failed: {}", error.message);
                    }
                }
                next_tick = std::time::Instant::now() + std::time::Duration::from_secs(30);
            }
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
    }
}
