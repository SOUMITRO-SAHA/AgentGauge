//! The wire contract between the renderer and Rust.
//!
//! One command, one request type, one response type. Every call is a tagged
//! `AppRequest` in and a tagged `AppResponse` out, so the client can exhaustively
//! match on both sides and a new capability is one enum variant rather than a
//! new command name.
//!
//! Why an envelope instead of many `#[tauri::command]`s: a command-per-action
//! API gives the client N stringly-typed entry points with no shared shape, so
//! "what can the app do?" cannot be answered by reading one type, and every
//! addition risks drifting argument naming. An envelope makes the protocol
//! enumerable and versionable in one place.

use serde::{Deserialize, Serialize};

use crate::modules::about::AppInfo;
use crate::modules::automation::AutomationState;
use crate::modules::cli_detection::CliToolStatus;
use crate::modules::kickoff::KickoffOverview;
use crate::modules::onboarding::{OnboardingProgress, OnboardingStep};
use crate::modules::permissions::VolumeAccessStatus;
use crate::modules::process_insights::ProcessInsights as ProcessInsightsReport;
use crate::modules::updates::UpdateChannel;
use crate::modules::widget::SystemWidgetStatus;
use crate::shared::domain::{
    AccountUsage, CodingSubscription, LocalUsage, PlanKind, ProviderKind, UsageSnapshot,
};
use crate::shared::error::Error;
use crate::shared::provider::{PingOutcome, ProviderStatus};

/// Protocol version. Bumped only for a breaking change; the client reads it so
/// a mismatched renderer and binary is diagnosable rather than mysterious.
pub const PROTOCOL_VERSION: u16 = 1;

/// Every capability the renderer can invoke.
///
/// Internally tagged on `type` in camelCase, so a payload is
/// `{"type":"readUsage"}` or `{"type":"readUsageFor","provider":"codex"}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AppRequest {
    /// Handshake. Answers with [`AppResponse::Protocol`].
    Hello,
    /// Probes every provider without starting a long-lived process.
    ProviderStatus,
    /// Facts about this build, and the outbound links the Settings screen offers.
    AppInfo,
    UpdateChannel,
    UpgradeHomebrew {
        version: String,
    },
    /// Opens one of the app's own outbound links in the user's browser.
    ///
    /// The URL is validated against the allowlist in `modules::about` before
    /// the opener runs, so this is not a generic "open anything" capability.
    OpenLink {
        url: String,
    },
    /// Detects supported coding-agent CLIs without starting sessions.
    CliDetection,
    /// Reads the read-only process and storage insights for the app and the
    /// tracked CLIs.
    ///
    /// Deliberately a bare read with no counterpart write: there is no
    /// capability to stop, signal, or delete anything, so read-onlyness is a
    /// property of the protocol rather than a promise of one screen.
    ProcessInsights,
    /// Lists the coding subscriptions the user connected through OpenCode.
    ///
    /// Read-only: asks OpenCode itself what is connected, and never touches a
    /// credential beyond asking whether one exists.
    OpenCodeSubscriptions,
    /// Reads usage for every provider.
    ReadUsage,
    /// Reads usage for one provider, propagating its failure.
    ReadUsageFor {
        provider: ProviderKind,
    },
    /// Reads account activity for one provider.
    ReadAccountUsage {
        provider: ProviderKind,
    },
    /// Reads local harness activity for one provider.
    ReadLocalUsage {
        provider: ProviderKind,
    },
    /// Reads the account plan tier, which an API-key account does not have.
    ReadPlan {
        provider: ProviderKind,
    },
    /// Sends the minimal prompt that proves the account can still answer.
    ///
    /// Spends quota. Nothing may send this on a timer the user did not opt into.
    SendPing {
        prompt: Option<String>,
    },
    /// Every sub's rollover-monitor state.
    AutomationState,
    /// Starts one sub's rollover monitor. Idempotent, and persisted: the
    /// choice survives a relaunch.
    StartAutomation {
        kind: ProviderKind,
    },
    /// Stops one sub's rollover monitor. Persisted.
    StopAutomation {
        kind: ProviderKind,
    },
    /// Clears a detected rollover once the UI has shown it.
    AcknowledgeRollover {
        kind: ProviderKind,
    },
    /// The scheduled kickoff's per-subscription state and scheduler status.
    KickoffState,
    /// Opts one subscription into (or out of) the scheduled kickoff.
    ///
    /// This is the explicit quota-spending opt-in: nothing may schedule a
    /// prompt without a `true` that arrived through this request.
    SetKickoffEnabled {
        kind: ProviderKind,
        enabled: bool,
    },
    /// Selects the model the scheduled kickoff uses for one subscription.
    SetKickoffModel {
        kind: ProviderKind,
        #[serde(rename = "modelId")]
        model_id: String,
    },
    /// Selects the effort the scheduled kickoff uses for one subscription.
    SetKickoffEffort {
        kind: ProviderKind,
        #[serde(rename = "effortId")]
        effort_id: String,
    },
    /// Onboarding progress, shaped for a progress indicator.
    OnboardingProgress,
    /// Persists onboarding progress.
    SetOnboardingStep {
        step: OnboardingStep,
        #[serde(default)]
        dismissed: bool,
    },
    /// Whether the platform's own system widget can be used, and how to set it up.
    ///
    /// There is deliberately no "create widget" capability. The macOS widget is a
    /// WidgetKit extension placed by the user through the system's own gallery, so
    /// the app can only report what is true and explain the procedure — it cannot
    /// install it, and must not pretend to have done so.
    SystemWidgetStatus,
    /// Whether the data paths this app reads are on a removable volume and
    /// whether the user has consented to the access through the in-app modal.
    ///
    /// The check resolves data roots from the environment without touching the
    /// removable volume itself, so it never triggers a macOS TCC dialog.
    VolumeAccess,
    /// Records the user's in-app consent for removable-volume access.
    ///
    /// The consent is durable — once granted it survives a relaunch, so the
    /// in-app modal shows at most once per database lifetime.
    GrantVolumeAccess,
    /// The renderer's persisted preferences, so a choice survives a relaunch.
    UiState,
    /// Persists the renderer's preferences.
    ///
    /// The route vocabulary is the renderer's; see `modules::settings` for why
    /// this is stored opaquely rather than as a Rust enum.
    SetUiState {
        /// The destination to reopen on, if the user has chosen one.
        ///
        /// Named on the field itself: the enum-level `rename_all` covers variant
        /// names only, and this is the protocol's first multi-word field.
        #[serde(default, rename = "lastRoute")]
        last_route: Option<String>,
    },
}

impl AppRequest {
    /// The capability's stable name.
    ///
    /// Doubles as the wire tag, so the discriminator in a log line and the one
    /// the client switches on are the same string by construction.
    pub const fn name(&self) -> &'static str {
        match self {
            Self::Hello => "hello",
            Self::ProviderStatus => "providerStatus",
            Self::AppInfo => "appInfo",
            Self::UpdateChannel => "updateChannel",
            Self::UpgradeHomebrew { .. } => "upgradeHomebrew",
            Self::OpenLink { .. } => "openLink",
            Self::CliDetection => "cliDetection",
            Self::ProcessInsights => "processInsights",
            Self::OpenCodeSubscriptions => "openCodeSubscriptions",
            Self::ReadUsage => "readUsage",
            Self::ReadUsageFor { .. } => "readUsageFor",
            Self::ReadAccountUsage { .. } => "readAccountUsage",
            Self::ReadLocalUsage { .. } => "readLocalUsage",
            Self::ReadPlan { .. } => "readPlan",
            Self::SendPing { .. } => "sendPing",
            Self::AutomationState => "automationState",
            Self::StartAutomation { .. } => "startAutomation",
            Self::StopAutomation { .. } => "stopAutomation",
            Self::AcknowledgeRollover { .. } => "acknowledgeRollover",
            Self::KickoffState => "kickoffState",
            Self::SetKickoffEnabled { .. } => "setKickoffEnabled",
            Self::SetKickoffModel { .. } => "setKickoffModel",
            Self::SetKickoffEffort { .. } => "setKickoffEffort",
            Self::OnboardingProgress => "onboardingProgress",
            Self::SetOnboardingStep { .. } => "setOnboardingStep",
            Self::SystemWidgetStatus => "systemWidgetStatus",
            Self::VolumeAccess => "volumeAccess",
            Self::GrantVolumeAccess => "grantVolumeAccess",
            Self::UiState => "uiState",
            Self::SetUiState { .. } => "setUiState",
        }
    }
}

/// Every response the renderer can receive.
///
/// A failure is a value here, not a rejected promise: the client can then
/// distinguish "the provider said no" (`failure`) from "the bridge broke"
/// (`IpcError` in the client layer) without string matching.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AppResponse {
    /// Handshake acknowledgement.
    Protocol {
        version: u16,
    },
    ProviderStatuses {
        providers: Vec<ProviderStatus>,
    },
    /// This build's facts and outbound links.
    AppInfo {
        info: AppInfo,
    },
    UpdateChannel {
        channel: UpdateChannel,
    },
    HomebrewUpgraded,
    /// An outbound link was handed to the system opener.
    LinkOpened,
    CliDetections {
        tools: Vec<CliToolStatus>,
    },
    ProcessInsights {
        insights: ProcessInsightsReport,
    },
    OpenCodeSubscriptions {
        subscriptions: Vec<CodingSubscription>,
    },
    Usage {
        snapshots: Vec<UsageSnapshot>,
    },
    AccountUsage {
        usage: AccountUsage,
    },
    LocalUsage {
        usage: Option<LocalUsage>,
    },
    Plan {
        plan: Option<PlanKind>,
    },
    Ping {
        outcome: PingOutcome,
    },
    Automation {
        monitors: Vec<AutomationState>,
    },
    /// The scheduled kickoff's overview: per-subscription state plus the
    /// system scheduler's status.
    Kickoff {
        state: KickoffOverview,
    },
    Onboarding {
        progress: OnboardingProgress,
    },
    SystemWidget {
        status: SystemWidgetStatus,
    },
    VolumeAccess {
        status: VolumeAccessStatus,
    },
    /// The renderer's persisted preferences.
    UiState {
        state: crate::modules::settings::UiState,
    },
    /// A request that could not be satisfied.
    Failure {
        error: Error,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::domain::CredentialOrigin;
    use crate::shared::error::ErrorKind;

    #[test]
    fn a_request_round_trips_through_the_envelope() {
        let request = AppRequest::ReadUsageFor {
            provider: ProviderKind::Codex,
        };
        let json = serde_json::to_string(&request).expect("serializes");
        assert_eq!(json, r#"{"type":"readUsageFor","provider":"codex"}"#);
        assert_eq!(
            serde_json::from_str::<AppRequest>(&json).expect("deserializes"),
            request
        );
    }

    #[test]
    fn a_request_with_no_arguments_is_a_bare_tag() {
        let json = serde_json::to_string(&AppRequest::ReadUsage).expect("serializes");
        assert_eq!(json, r#"{"type":"readUsage"}"#);
    }

    #[test]
    fn cli_detection_is_a_bare_read_only_request() {
        let request: AppRequest =
            serde_json::from_str(r#"{"type":"cliDetection"}"#).expect("deserializes");
        assert_eq!(request, AppRequest::CliDetection);
        assert_eq!(request.name(), "cliDetection");
    }

    #[test]
    fn process_insights_is_a_bare_read_only_request() {
        let request: AppRequest =
            serde_json::from_str(r#"{"type":"processInsights"}"#).expect("deserializes");
        assert_eq!(request, AppRequest::ProcessInsights);
        assert_eq!(request.name(), "processInsights");
    }

    #[test]
    fn a_process_insights_reply_carries_the_report_under_its_own_tag() {
        let response = AppResponse::ProcessInsights {
            insights: ProcessInsightsReport {
                fetched_at: 1,
                groups: Vec::new(),
            },
        };
        let json = serde_json::to_value(&response).expect("serializes");
        assert_eq!(json["type"], "processInsights");
        assert_eq!(json["insights"]["fetchedAt"], 1);
    }

    #[test]
    fn an_optional_ping_prompt_may_be_omitted() {
        let json = r#"{"type":"sendPing"}"#;
        let request: AppRequest = serde_json::from_str(json).expect("deserializes");
        assert_eq!(request, AppRequest::SendPing { prompt: None });
    }

    #[test]
    fn a_failed_onboarding_save_defaults_dismissed_to_false() {
        // The renderer may omit the flag; it must not become an accidental true.
        let request: AppRequest =
            serde_json::from_str(r#"{"type":"setOnboardingStep","step":"widget"}"#)
                .expect("deserializes");
        assert_eq!(
            request,
            AppRequest::SetOnboardingStep {
                step: OnboardingStep::Widget,
                dismissed: false,
            }
        );
    }

    #[test]
    fn ui_state_round_trips_through_the_envelope() {
        let request = AppRequest::SetUiState {
            last_route: Some("stats".into()),
        };
        let json = serde_json::to_string(&request).expect("serializes");
        // camelCase on the field, tagged on `type` — same as every other request.
        assert_eq!(json, r#"{"type":"setUiState","lastRoute":"stats"}"#);
        assert_eq!(
            serde_json::from_str::<AppRequest>(&json).expect("deserializes"),
            request
        );
    }

    #[test]
    fn ui_state_names_are_stable_for_the_dispatch_log() {
        assert_eq!(AppRequest::UiState.name(), "uiState");
        assert_eq!(
            AppRequest::SetUiState { last_route: None }.name(),
            "setUiState"
        );
    }

    #[test]
    fn a_set_ui_state_may_clear_the_choice() {
        let request: AppRequest = serde_json::from_str(r#"{"type":"setUiState","lastRoute":null}"#)
            .expect("deserializes");
        assert_eq!(request, AppRequest::SetUiState { last_route: None });
    }

    #[test]
    fn kickoff_model_uses_camel_case_field() {
        let json = r#"{"type":"setKickoffModel","kind":"codex","modelId":"gpt-6-luna"}"#;
        let request: AppRequest = serde_json::from_str(json).expect("deserializes");
        assert_eq!(
            request,
            AppRequest::SetKickoffModel {
                kind: ProviderKind::Codex,
                model_id: "gpt-6-luna".into(),
            }
        );
        assert_eq!(serde_json::to_string(&request).expect("serializes"), json);
    }

    #[test]
    fn kickoff_effort_uses_camel_case_field() {
        let json = r#"{"type":"setKickoffEffort","kind":"codex","effortId":"low"}"#;
        let request: AppRequest = serde_json::from_str(json).expect("deserializes");
        assert_eq!(
            request,
            AppRequest::SetKickoffEffort {
                kind: ProviderKind::Codex,
                effort_id: "low".into(),
            }
        );
        assert_eq!(serde_json::to_string(&request).expect("serializes"), json);
    }

    #[test]
    fn an_unknown_request_is_rejected_rather_than_defaulted() {
        // Silently defaulting an unknown capability would make a client bug look
        // like a working one.
        assert!(serde_json::from_str::<AppRequest>(r#"{"type":"nukeEverything"}"#).is_err());
    }

    #[test]
    fn an_unknown_provider_is_rejected() {
        assert!(
            serde_json::from_str::<AppRequest>(r#"{"type":"readPlan","provider":"evil"}"#).is_err()
        );
    }

    #[test]
    fn every_request_name_is_unique() {
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
            AppRequest::ReadLocalUsage {
                provider: ProviderKind::Codex,
            },
            AppRequest::ReadPlan {
                provider: ProviderKind::Codex,
            },
            AppRequest::SendPing { prompt: None },
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
            AppRequest::OnboardingProgress,
            AppRequest::OpenCodeSubscriptions,
            AppRequest::ProcessInsights,
            AppRequest::KickoffState,
            AppRequest::SetKickoffEnabled {
                kind: ProviderKind::Codex,
                enabled: false,
            },
            AppRequest::SetKickoffModel {
                kind: ProviderKind::Codex,
                model_id: "gpt-6-luna".into(),
            },
            AppRequest::SetKickoffEffort {
                kind: ProviderKind::Codex,
                effort_id: "minimal".into(),
            },
            AppRequest::SetOnboardingStep {
                step: OnboardingStep::Done,
                dismissed: false,
            },
            AppRequest::SystemWidgetStatus,
            AppRequest::VolumeAccess,
            AppRequest::GrantVolumeAccess,
        ];
        let mut names: Vec<&str> = all.iter().map(AppRequest::name).collect();
        let count = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), count, "request names must be unique");
    }

    #[test]
    fn a_failure_is_a_tagged_response_not_a_bare_string() {
        let response = AppResponse::Failure {
            error: Error::timeout("no reply"),
        };
        let json = serde_json::to_value(&response).expect("serializes");
        assert_eq!(json["type"], "failure");
        assert_eq!(json["error"]["kind"], ErrorKind::Timeout.as_str());
        assert_eq!(json["error"]["message"], "no reply");
    }

    #[test]
    fn the_handshake_reports_the_protocol_version() {
        let json = serde_json::to_value(AppResponse::Protocol {
            version: PROTOCOL_VERSION,
        })
        .expect("serializes");
        assert_eq!(json["type"], "protocol");
        assert_eq!(json["version"], 1);
    }

    #[test]
    fn a_usage_response_round_trips() {
        let snapshot = UsageSnapshot::unavailable(ProviderKind::Codex, "not installed");
        let response = AppResponse::Usage {
            snapshots: vec![snapshot.clone()],
        };
        let json = serde_json::to_string(&response).expect("serializes");
        let decoded: AppResponse = serde_json::from_str(&json).expect("deserializes");
        assert_eq!(decoded, response);
        assert!(json.contains("\"freshness\":\"unavailable\""));
    }

    #[test]
    fn a_missing_local_usage_response_round_trips() {
        let response = AppResponse::LocalUsage { usage: None };
        let json = serde_json::to_value(&response).expect("serializes");
        assert_eq!(json["type"], "localUsage");
        assert!(json["usage"].is_null());
        assert_eq!(
            serde_json::from_value::<AppResponse>(json).expect("deserializes"),
            response
        );
    }

    #[test]
    fn every_request_name_matches_the_serde_tag() {
        // `name()` doubles as the wire discriminator in logs; if it ever
        // disagrees with serde's tag, a client would send a tag the backend
        // rejects — an error that mocks cannot catch, because they match the
        // literal string rather than going through serde.
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
            AppRequest::ReadLocalUsage {
                provider: ProviderKind::Codex,
            },
            AppRequest::ReadPlan {
                provider: ProviderKind::Codex,
            },
            AppRequest::SendPing { prompt: None },
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
            AppRequest::OnboardingProgress,
            AppRequest::OpenCodeSubscriptions,
            AppRequest::ProcessInsights,
            AppRequest::KickoffState,
            AppRequest::SetKickoffEnabled {
                kind: ProviderKind::Codex,
                enabled: false,
            },
            AppRequest::SetKickoffModel {
                kind: ProviderKind::Codex,
                model_id: "gpt-6-luna".into(),
            },
            AppRequest::SetKickoffEffort {
                kind: ProviderKind::Codex,
                effort_id: "minimal".into(),
            },
            AppRequest::SetOnboardingStep {
                step: OnboardingStep::Done,
                dismissed: false,
            },
            AppRequest::SystemWidgetStatus,
            AppRequest::VolumeAccess,
            AppRequest::GrantVolumeAccess,
        ];
        for request in &all {
            let json = serde_json::to_value(request).expect("serializes");
            assert_eq!(
                json["type"],
                request.name(),
                "{} disagreed with its serde tag",
                request.name()
            );
        }
    }

    #[test]
    fn subscription_listing_round_trips() {
        let response = AppResponse::OpenCodeSubscriptions {
            subscriptions: vec![CodingSubscription {
                provider_id: "zai-coding-plan".to_string(),
                name: "Z.AI Coding Plan".to_string(),
                label: "Z.AI".to_string(),
                integration: Some(ProviderKind::Zai),
                credential: CredentialOrigin::Stored,
                api_base: Some("https://api.z.ai/api/coding/paas/v4".to_string()),
            }],
        };
        let json = serde_json::to_value(&response).expect("serializes");
        assert_eq!(json["type"], "openCodeSubscriptions");
        assert_eq!(json["subscriptions"][0]["integration"], "zai");
        let decoded: AppResponse = serde_json::from_value(json).expect("deserializes");
        assert_eq!(decoded, response);
    }
}
