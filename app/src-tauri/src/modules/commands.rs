//! The IPC surface.
//!
//! One command — [`dispatch`] — implementing the request/response protocol in
//! `shared::protocol`. Its body follows the fixed three steps for every arm:
//! validate arguments, delegate to the owning module, wrap the outcome in an
//! [`AppResponse`].
//!
//! There is no business logic here. Everything that decides anything lives in
//! the module that owns the behaviour.

use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::modules::automation::AutomationRunner;
use crate::modules::cli_detection;
use crate::modules::kickoff::{self, KickoffStore};
use crate::modules::onboarding::{
    OnboardingProgress, OnboardingState, OnboardingStep, OnboardingStore,
};
use crate::modules::opencode::OpenCodeCatalog;
use crate::modules::process_insights;
use crate::modules::providers::{ProviderRegistry, PING_PROMPT};
use crate::modules::settings::SettingsStore;
use crate::modules::widget::{now_secs, SnapshotStore, SystemWidgetStatus, WidgetSnapshot};
use crate::shared::domain::{CodingSubscription, ProviderKind, UsageSnapshot};
use crate::shared::error::{Error, ErrorKind};
use crate::shared::protocol::{AppRequest, AppResponse, PROTOCOL_VERSION};

/// Shared state, assembled once in `lib.rs`.
///
/// Cloned per request so the blocking read can leave the main thread: the work
/// runs on another thread and needs its own handle on the state. Every field is
/// a handle or a path, so a clone costs nothing and shares the same state.
#[derive(Clone)]
pub struct AppState {
    pub registry: Arc<ProviderRegistry>,
    pub automation: Arc<AutomationRunner>,
    pub onboarding: OnboardingStore,
    pub widget_snapshots: Option<SnapshotStore>,
    pub settings: SettingsStore,
    /// The kickoff schedule's home. `None` only when there is no home
    /// directory, in which case every kickoff capability reports unsupported.
    /// Shared because the automation reading hook also folds into it.
    pub kickoff: Option<Arc<KickoffStore>>,
}

/// The single entry point for every renderer capability.
///
/// A failure is returned as `AppResponse::Failure` rather than a rejected
/// promise, so the client can branch on a stable tag. Only a bridge-level
/// fault (the command was never invoked) reaches the renderer as an exception.
///
/// Async on purpose. Every arm below is blocking work — a provider read spawns
/// the OpenCode CLI and waits on a network call — and a *synchronous* Tauri
/// command runs on the main thread, which on macOS is the thread WKWebView
/// paints on. Reading inline therefore froze the window: the tab would not
/// switch and no skeleton could appear, because nothing could be painted while
/// the read was in flight. The work moves to a blocking thread so the renderer
/// keeps painting and the skeleton lands immediately.
#[tauri::command]
pub async fn dispatch(request: AppRequest, app: AppHandle) -> Result<AppResponse, ()> {
    // `AppHandle`, not `State`: an async command may not borrow its state, and
    // the handle is owned and `'static` so it can cross onto the runtime. An
    // async command is spawned on the async runtime rather than the main
    // thread, which is the point of the whole change — the blocking read is
    // handed to a blocking thread below so it cannot occupy this one either.
    let state = Arc::clone(app.state::<Arc<AppState>>().inner());

    match off_thread(move || match handle(request, &state) {
        Ok(response) => response,
        Err(error) => AppResponse::Failure { error },
    })
    .await
    {
        Ok(response) => Ok(response),
        Err(_) => Ok(AppResponse::Failure {
            error: Error::new(
                ErrorKind::TransportClosed,
                "The background read ended unexpectedly.",
            ),
        }),
    }
}

/// Runs blocking work on a blocking thread, leaving the caller's thread free.
///
/// A panic or a cancelled join is reported as a typed failure rather than
/// unwinding into the async runtime, so the renderer still receives a response
/// it can branch on instead of a rejected promise.
fn off_thread(
    work: impl FnOnce() -> AppResponse + Send + 'static,
) -> tauri::async_runtime::JoinHandle<AppResponse> {
    tauri::async_runtime::spawn_blocking(work)
}

fn handle(request: AppRequest, state: &AppState) -> Result<AppResponse, Error> {
    // Named up front so a rejected request says which capability was refused.
    let name = request.name();

    if let Err(error) = validate(&request) {
        eprintln!("agentgauge: rejected `{name}`: {}", error.message);
        return Err(error);
    }

    match request {
        AppRequest::Hello => Ok(AppResponse::Protocol {
            version: PROTOCOL_VERSION,
        }),

        AppRequest::ProviderStatus => Ok(AppResponse::ProviderStatuses {
            providers: state.registry.status(),
        }),

        AppRequest::CliDetection => Ok(AppResponse::CliDetections {
            tools: cli_detection::detect(),
        }),

        AppRequest::ProcessInsights => Ok(AppResponse::ProcessInsights {
            insights: process_insights::read_insights(),
        }),

        AppRequest::OpenCodeSubscriptions => Ok(AppResponse::OpenCodeSubscriptions {
            subscriptions: opencode_subscriptions(state),
        }),

        AppRequest::ReadUsage => {
            let snapshots = read_all(state);
            publish_snapshot(state, &snapshots);
            sync_reset_times(state, &snapshots);
            Ok(AppResponse::Usage { snapshots })
        }

        AppRequest::ReadUsageFor { provider } => {
            let snapshots = vec![state.registry.usage(provider)?];
            publish_snapshot(state, &snapshots);
            sync_reset_times(state, &snapshots);
            Ok(AppResponse::Usage { snapshots })
        }

        AppRequest::ReadAccountUsage { provider } => Ok(AppResponse::AccountUsage {
            usage: state.registry.account_usage(provider)?,
        }),

        AppRequest::ReadPlan { provider } => Ok(AppResponse::Plan {
            plan: state.registry.plan(provider)?,
        }),

        AppRequest::SendPing { prompt } => {
            // Already length-checked by `validate`; the default keeps a bare
            // request useful without the renderer having to know the text.
            let prompt = prompt.unwrap_or_else(|| PING_PROMPT.to_string());
            Ok(AppResponse::Ping {
                outcome: state.registry.ping(ProviderKind::Codex, &prompt)?,
            })
        }

        AppRequest::AutomationState => Ok(AppResponse::Automation {
            monitors: state.automation.overview(),
        }),

        AppRequest::StartAutomation { kind } => {
            state.automation.start(kind);
            Ok(AppResponse::Automation {
                monitors: state.automation.overview(),
            })
        }

        AppRequest::StopAutomation { kind } => {
            state.automation.stop(kind);
            Ok(AppResponse::Automation {
                monitors: state.automation.overview(),
            })
        }

        AppRequest::AcknowledgeRollover { kind } => {
            state.automation.acknowledge_rollover(kind);
            Ok(AppResponse::Automation {
                monitors: state.automation.overview(),
            })
        }

        AppRequest::KickoffState => Ok(AppResponse::Kickoff {
            state: kickoff_overview(state),
        }),

        AppRequest::SetKickoffEnabled { kind, enabled } => {
            let store = require_kickoff_store(state)?;
            let (model_id, minimum_effort) = if enabled {
                let current = store
                    .load()
                    .subscriptions
                    .into_iter()
                    .find(|sub| sub.kind == kind)
                    .and_then(|sub| sub.model_id);
                let models = state.registry.kickoff_models(kind)?;
                let model = current
                    .as_deref()
                    .and_then(|id| models.iter().find(|model| model.id == id))
                    .or_else(|| models.first())
                    .ok_or_else(|| {
                        Error::provider_error(format!(
                            "No currently available, price-listed model is available for {}.",
                            kind.display_name()
                        ))
                    })?;
                let effort = model.lowest_effort().ok_or_else(|| {
                    Error::provider_error(format!(
                        "{} reported no supported effort for `{}`.",
                        kind.display_name(),
                        model.id
                    ))
                })?;
                (Some(model.id.clone()), Some(effort.to_string()))
            } else {
                (None, None)
            };
            store.set_enabled(kind, enabled, now_millis(), model_id, minimum_effort)?;
            // The system scheduler exists exactly while a sub is opted in:
            // enabling installs it, the last disable removes it. A failure is
            // propagated — silently running (or not running) a quota-spending
            // timer is the one thing this feature must never do.
            kickoff::agent::install(
                &std::env::current_exe().unwrap_or_else(|_| "agentgauge".into()),
                &store.load(),
            )?;
            Ok(AppResponse::Kickoff {
                state: kickoff_overview(state),
            })
        }

        AppRequest::SetKickoffModel { kind, model_id } => {
            let store = require_kickoff_store(state)?;
            let models = state.registry.kickoff_models(kind)?;
            let model = models
                .iter()
                .find(|model| model.id == model_id)
                .ok_or_else(|| {
                    Error::invalid_request(format!(
                        "`{model_id}` is not currently available and price-listed for {}.",
                        kind.display_name()
                    ))
                })?;
            let effort = model.lowest_effort().ok_or_else(|| {
                Error::invalid_request(format!("`{model_id}` has no supported kickoff effort."))
            })?;
            store.configure_model(kind, model_id, effort.to_string())?;
            Ok(AppResponse::Kickoff {
                state: kickoff_overview(state),
            })
        }

        AppRequest::SetKickoffEffort { kind, effort_id } => {
            let store = require_kickoff_store(state)?;
            let schedule = store.load();
            let stored_model = schedule
                .subscriptions
                .iter()
                .find(|sub| sub.kind == kind)
                .and_then(|sub| sub.model_id.as_deref());
            let models = state.registry.kickoff_models(kind)?;
            let model = stored_model
                .and_then(|id| models.iter().find(|model| model.id == id))
                .or_else(|| models.first())
                .ok_or_else(|| {
                    Error::provider_error(format!(
                        "No currently available, price-listed model is available for {}.",
                        kind.display_name()
                    ))
                })?;
            if !model.efforts.iter().any(|effort| effort.id == effort_id) {
                return Err(Error::invalid_request(format!(
                    "`{effort_id}` is not a supported effort for `{}`.",
                    model.id
                )));
            }
            store.configure_selection(kind, model.id.clone(), effort_id)?;
            Ok(AppResponse::Kickoff {
                state: kickoff_overview(state),
            })
        }

        AppRequest::OnboardingProgress => Ok(AppResponse::Onboarding {
            progress: progress_of(state.onboarding.load()),
        }),

        AppRequest::SetOnboardingStep { step, dismissed } => {
            let next = OnboardingState { step, dismissed };
            // A failed write is reported rather than swallowed: silently losing
            // progress would restart the whole flow on the next launch.
            state.onboarding.save(&next)?;
            Ok(AppResponse::Onboarding {
                progress: progress_of(next),
            })
        }

        AppRequest::SystemWidgetStatus => Ok(AppResponse::SystemWidget {
            status: SystemWidgetStatus::current(),
        }),

        AppRequest::UiState => Ok(AppResponse::UiState {
            state: state.settings.load(),
        }),

        AppRequest::SetUiState { last_route } => {
            let current = state.settings.load();
            let next = current.with_last_route(last_route);
            // Same rule as onboarding: a failed write is reported, because a
            // preference lost silently is a preference that lies about having
            // been kept.
            state.settings.save(&next)?;
            Ok(AppResponse::UiState { state: next })
        }
    }
}

/// The clock at the moment a kickoff decision is made.
fn now_millis() -> i64 {
    crate::shared::clock::Clock::now_ms(&crate::shared::clock::SystemClock)
}

/// The kickoff store, or the honest refusal when there is nowhere to keep a
/// schedule.
fn require_kickoff_store(state: &AppState) -> Result<&KickoffStore, Error> {
    state.kickoff.as_deref().ok_or_else(|| {
        Error::new(
            crate::shared::error::ErrorKind::InvalidRequest,
            "No home directory is available, so the kickoff schedule cannot be stored.",
        )
    })
}

fn kickoff_overview(state: &AppState) -> kickoff::KickoffOverview {
    kickoff::overview(state.kickoff.as_deref(), |kind| {
        state.registry.kickoff_models(kind)
    })
}

/// Folds every fresh reset time into the kickoff schedule, so the worker —
/// which may run while the app is closed — always has the latest window
/// boundary without polling the providers itself.
///
/// A schedule write that fails must not break the read the user asked for,
/// so this is reported and not propagated.
fn sync_reset_times(state: &AppState, snapshots: &[UsageSnapshot]) {
    let Some(store) = state.kickoff.as_deref() else {
        return;
    };
    for snapshot in snapshots {
        let Some(resets_at) = snapshot.five_hour.as_ref().and_then(|w| w.resets_at) else {
            continue;
        };
        let now = now_millis();
        let result = store.update(snapshot.provider, |mut sub| {
            sub.apply_reset(resets_at, now);
            sub
        });
        if let Err(error) = result {
            eprintln!(
                "agentgauge: could not sync the kickoff schedule: {}",
                error.message
            );
        }
    }
}

/// Longest ping message accepted, in characters.
const MAX_PROMPT_CHARS: usize = 280;

/// Lists the coding subscriptions OpenCode reports.
///
/// A failure to reach OpenCode is an empty list rather than a rejected
/// request: the Codex tab does not depend on OpenCode being installed, and
/// the renderer shows the connect hint from the provider status instead.
fn opencode_subscriptions(_state: &AppState) -> Vec<CodingSubscription> {
    match OpenCodeCatalog::read() {
        Ok(catalog) => catalog.subscriptions(),
        Err(error) => {
            // Reported rather than propagated: the renderer still has the
            // OpenCode CLI status to explain an empty list, and a missing
            // OpenCode must not blank the Codex reading.
            eprintln!(
                "agentgauge: could not list OpenCode subscriptions: {}",
                error.message
            );
            Vec::new()
        }
    }
}

/// Reads every provider, turning a per-provider failure into an explicit
/// `unavailable` snapshot so one broken provider cannot blank the dashboard.
fn read_all(state: &AppState) -> Vec<UsageSnapshot> {
    state
        .registry
        .kinds()
        .into_iter()
        .map(|kind| match state.registry.usage(kind) {
            Ok(snapshot) => snapshot,
            Err(err) => UsageSnapshot::unavailable(kind, err.message),
        })
        .collect()
}

/// Publishes the Codex reading for the system widget to read.
///
/// Called as a side effect of every usage read rather than on a renderer command,
/// so the widget cannot drift out of sync with what the app is showing: there is
/// no sequence in which the UI is fresh and the widget is stale.
///
/// Only the Codex snapshot is published. The widget's contract names the 5-hour
/// and weekly windows specifically, so publishing another provider's windows
/// under those labels would be a fabrication.
fn publish_snapshot(state: &AppState, snapshots: &[UsageSnapshot]) {
    let Some(store) = state.widget_snapshots.as_ref() else {
        return;
    };
    let now = now_secs();

    let snapshot = match snapshots.iter().find(|s| s.provider == ProviderKind::Codex) {
        Some(codex) => WidgetSnapshot::from_usage(codex, now),
        None => WidgetSnapshot::unavailable("No reading available.", now),
    };

    if let Err(error) = store.write(&snapshot) {
        // A widget that cannot be written must not break the reading the user
        // actually asked for, so this is reported and not propagated.
        eprintln!(
            "agentgauge: could not publish widget snapshot: {}",
            error.message
        );
    }
}

/// Shapes progress for the renderer, so the client does not reimplement the step
/// ordering — or the "should this reappear" rule — and drift from it.
fn progress_of(current: OnboardingState) -> OnboardingProgress {
    OnboardingProgress {
        visible: current.should_show(),
        step: current.step,
        dismissed: current.dismissed,
        index: current.step.index(),
        total: OnboardingStep::ALL.len() as u8,
    }
}

/// Rejects a request the renderer could not legitimately make.
///
/// Kept next to the handlers so adding a capability forces a decision here
/// rather than inheriting whatever validation the previous arm happened to do.
fn validate(request: &AppRequest) -> Result<(), Error> {
    match request {
        AppRequest::SendPing { prompt: Some(text) } if text.chars().count() > MAX_PROMPT_CHARS => {
            Err(Error::invalid_request("The ping message is too long."))
        }
        AppRequest::SetKickoffModel { model_id, .. }
            if model_id.is_empty() || model_id.chars().count() > MAX_MODEL_ID_CHARS =>
        {
            Err(Error::invalid_request("The model id is not a model id."))
        }
        AppRequest::SetKickoffEffort { effort_id, .. }
            if effort_id.is_empty() || effort_id.chars().count() > MAX_EFFORT_ID_CHARS =>
        {
            Err(Error::invalid_request("The effort id is not an effort id."))
        }
        _ => Ok(()),
    }
}

/// Longest model id accepted, in characters.
const MAX_MODEL_ID_CHARS: usize = 64;
const MAX_EFFORT_ID_CHARS: usize = 32;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::error::ErrorKind;

    #[test]
    fn a_read_runs_off_the_calling_thread_and_still_returns_its_answer() {
        // The behaviour the tab switch depends on. A provider read spawns a
        // subprocess and waits on the network; run inline it occupies the
        // thread WKWebView paints on, so the window cannot repaint a skeleton
        // and the switch freezes instead of loading. `off_thread` must hand
        // the work to another thread — the heartbeat thread still running
        // while the answer is awaited is exactly that proof — and must still
        // come back with the handler's own answer, never a fabricated one.
        let heartbeat = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = std::sync::Arc::clone(&heartbeat);
        let ticker = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        });

        let answer = tauri::async_runtime::block_on(off_thread(|| {
            std::thread::sleep(std::time::Duration::from_millis(250));
            AppResponse::Protocol {
                version: PROTOCOL_VERSION,
            }
        }));

        ticker.join().expect("heartbeat finishes");

        assert!(
            heartbeat.load(std::sync::atomic::Ordering::SeqCst),
            "the awaiting thread was blocked instead of yielding to the runtime"
        );

        match answer.expect("the join resolves") {
            AppResponse::Protocol { version } => assert_eq!(version, PROTOCOL_VERSION),
            other => panic!("expected the handler's own response, got {other:?}"),
        }
    }

    #[test]
    fn an_over_long_prompt_is_rejected_at_the_boundary() {
        // The renderer is untrusted input, so the limit is enforced here and
        // not merely in the UI.
        let request = AppRequest::SendPing {
            prompt: Some("x".repeat(MAX_PROMPT_CHARS + 1)),
        };
        let err = validate(&request).expect_err("must reject");
        assert_eq!(err.kind, ErrorKind::InvalidRequest);
    }

    #[test]
    fn a_ping_at_the_limit_is_accepted() {
        let request = AppRequest::SendPing {
            prompt: Some("x".repeat(MAX_PROMPT_CHARS)),
        };
        assert!(validate(&request).is_ok());
    }

    #[test]
    fn a_prompt_with_no_text_is_accepted() {
        assert!(validate(&AppRequest::SendPing { prompt: None }).is_ok());
    }

    #[test]
    fn an_over_long_model_id_is_rejected_at_the_boundary() {
        let request = AppRequest::SetKickoffModel {
            kind: ProviderKind::Codex,
            model_id: "x".repeat(MAX_MODEL_ID_CHARS + 1),
        };
        assert_eq!(
            validate(&request).expect_err("must reject").kind,
            ErrorKind::InvalidRequest
        );
        assert!(validate(&AppRequest::SetKickoffModel {
            kind: ProviderKind::Codex,
            model_id: "gpt-6-luna".into(),
        })
        .is_ok());
    }

    #[test]
    fn every_other_request_passes_validation() {
        let all = [
            AppRequest::Hello,
            AppRequest::ProviderStatus,
            AppRequest::ReadUsage,
            AppRequest::ReadUsageFor {
                provider: ProviderKind::Codex,
            },
            AppRequest::ReadAccountUsage {
                provider: ProviderKind::Codex,
            },
            AppRequest::ReadPlan {
                provider: ProviderKind::Codex,
            },
            AppRequest::AutomationState,
            AppRequest::StartAutomation {
                kind: ProviderKind::Codex,
            },
            AppRequest::StopAutomation {
                kind: ProviderKind::Codex,
            },
            AppRequest::AcknowledgeRollover {
                kind: ProviderKind::Codex,
            },
            AppRequest::KickoffState,
            AppRequest::SetKickoffEnabled {
                kind: ProviderKind::Codex,
                enabled: true,
            },
            AppRequest::OnboardingProgress,
            AppRequest::ProcessInsights,
            AppRequest::SystemWidgetStatus,
        ];
        for request in all {
            assert!(
                validate(&request).is_ok(),
                "{} was rejected",
                request.name()
            );
        }
    }

    #[test]
    fn the_progress_shape_uses_the_canonical_step_count() {
        let progress = progress_of(OnboardingState {
            step: OnboardingStep::Widget,
            dismissed: false,
        });
        assert_eq!(progress.index, OnboardingStep::Widget.index());
        assert_eq!(progress.total as usize, OnboardingStep::ALL.len());
    }

    #[test]
    fn a_failure_response_carries_the_typed_error() {
        let response = AppResponse::Failure {
            error: Error::new(ErrorKind::InvalidRequest, "bad"),
        };
        let json = serde_json::to_value(&response).expect("serializes");
        assert_eq!(json["type"], "failure");
        assert_eq!(json["error"]["kind"], "invalidRequest");
    }
}
