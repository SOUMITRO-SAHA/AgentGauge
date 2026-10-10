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

use tauri::State;

use crate::modules::automation::AutomationRunner;
use crate::modules::onboarding::{
    OnboardingProgress, OnboardingState, OnboardingStep, OnboardingStore,
};
use crate::modules::providers::{ProviderRegistry, PING_PROMPT};
use crate::modules::settings::{SettingsStore, UiState};
use crate::modules::widget::{now_secs, SnapshotStore, SystemWidgetStatus, WidgetSnapshot};
use crate::shared::domain::{ProviderKind, UsageSnapshot};
use crate::shared::error::Error;
use crate::shared::protocol::{AppRequest, AppResponse, PROTOCOL_VERSION};

/// Shared state, assembled once in `lib.rs`.
pub struct AppState {
    pub registry: Arc<ProviderRegistry>,
    pub automation: Arc<AutomationRunner>,
    pub onboarding: OnboardingStore,
    pub widget_snapshots: Option<SnapshotStore>,
    pub settings: SettingsStore,
}

/// The single entry point for every renderer capability.
///
/// A failure is returned as `AppResponse::Failure` rather than a rejected
/// promise, so the client can branch on a stable tag. Only a bridge-level
/// fault (the command was never invoked) reaches the renderer as an exception.
#[tauri::command]
pub fn dispatch(request: AppRequest, state: State<'_, AppState>) -> AppResponse {
    match handle(request, &state) {
        Ok(response) => response,
        Err(error) => AppResponse::Failure { error },
    }
}

fn handle(request: AppRequest, state: &AppState) -> Result<AppResponse, Error> {
    // Named up front so a rejected request says which capability was refused.
    let name = request.name();

    if let Err(error) = validate(&request) {
        eprintln!("agentgauge-daemon: rejected `{name}`: {}", error.message);
        return Err(error);
    }

    match request {
        AppRequest::Hello => Ok(AppResponse::Protocol {
            version: PROTOCOL_VERSION,
        }),

        AppRequest::ProviderStatus => Ok(AppResponse::ProviderStatuses {
            providers: state.registry.status(),
        }),

        AppRequest::ReadUsage => {
            let snapshots = read_all(state);
            publish_snapshot(state, &snapshots);
            Ok(AppResponse::Usage { snapshots })
        }

        AppRequest::ReadUsageFor { provider } => {
            let snapshots = vec![state.registry.usage(provider)?];
            publish_snapshot(state, &snapshots);
            Ok(AppResponse::Usage { snapshots })
        }

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
            state: state.automation.state(),
        }),

        AppRequest::StartAutomation => {
            state.automation.start();
            Ok(AppResponse::Automation {
                state: state.automation.state(),
            })
        }

        AppRequest::StopAutomation => {
            state.automation.stop();
            Ok(AppResponse::Automation {
                state: state.automation.state(),
            })
        }

        AppRequest::AcknowledgeRollover => {
            state.automation.acknowledge_rollover();
            Ok(AppResponse::Automation {
                state: state.automation.state(),
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
            let next = UiState::default().with_last_route(last_route);
            // Same rule as onboarding: a failed write is reported, because a
            // preference lost silently is a preference that lies about having
            // been kept.
            state.settings.save(&next)?;
            Ok(AppResponse::UiState { state: next })
        }
    }
}

/// Longest ping message accepted, in characters.
const MAX_PROMPT_CHARS: usize = 280;

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
            "agentgauge-daemon: could not publish widget snapshot: {}",
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
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::error::ErrorKind;

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
    fn every_other_request_passes_validation() {
        let all = [
            AppRequest::Hello,
            AppRequest::ProviderStatus,
            AppRequest::ReadUsage,
            AppRequest::ReadUsageFor {
                provider: ProviderKind::Codex,
            },
            AppRequest::ReadPlan {
                provider: ProviderKind::Codex,
            },
            AppRequest::AutomationState,
            AppRequest::StartAutomation,
            AppRequest::StopAutomation,
            AppRequest::AcknowledgeRollover,
            AppRequest::OnboardingProgress,
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
