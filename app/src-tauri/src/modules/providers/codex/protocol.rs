//! Decoding of the Codex app-server JSON-RPC wire format.
//!
//! Pure and side-effect free: every function here takes `&str` and returns a
//! domain value or an [`Error`]. The transport that actually speaks the
//! protocol lives in `super::transport`; nothing in this file knows that a
//! child process exists.
//!
//! Field names and nullability follow `codex-rs/app-server-protocol/src/
//! protocol/v2/account.rs` in the Codex repository. Two deliberate departures:
//! everything optional degrades rather than fails, and unknown enum variants
//! become `Unknown` instead of erroring, because a provider upgrade must not
//! blank the dashboard.

use serde::Deserialize;

use crate::shared::domain::{
    freshness_for, window_label, AccountUsage, AccountUsageSummary, DailyUsageBucket,
    KickoffEffortInfo, KickoffModelInfo, PlanKind, ProviderKind, UsagePermission, UsageSnapshot,
    UsageWindow, SOURCE_APP_SERVER,
};
use crate::shared::error::Error;

/// `RateLimitWindow` on the wire (`account.rs`).
///
/// `usedPercent` is a non-nullable integer: the backend rounds its float before
/// it crosses JSON.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireWindow {
    used_percent: i32,
    window_duration_mins: Option<i64>,
    resets_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireSnapshot {
    primary: Option<WireWindow>,
    secondary: Option<WireWindow>,
    plan_type: Option<String>,
    #[serde(default)]
    spend_control_reached: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireRateLimitsResponse {
    ordinary_usage_allowed: Option<bool>,
    rate_limits: Option<WireSnapshot>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireAccountUsage {
    summary: Option<WireAccountUsageSummary>,
    daily_usage_buckets: Option<Vec<WireDailyUsageBucket>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireAccountUsageSummary {
    lifetime_tokens: Option<u64>,
    peak_daily_tokens: Option<u64>,
    longest_running_turn_sec: Option<u64>,
    current_streak_days: Option<u64>,
    longest_streak_days: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireDailyUsageBucket {
    start_date: Option<String>,
    tokens: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireModelListPage {
    #[serde(default)]
    data: Vec<WireModel>,
    next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireModel {
    id: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    hidden: bool,
    #[serde(default)]
    supported_reasoning_efforts: Vec<WireReasoningEffort>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireReasoningEffort {
    reasoning_effort: String,
}

/// One page returned by Codex `model/list`.
pub struct KickoffModelPage {
    pub models: Vec<KickoffModelInfo>,
    pub next_cursor: Option<String>,
}

/// Decodes one page of Codex models and their supported reasoning efforts.
pub fn decode_model_list_page(payload: &str) -> Result<KickoffModelPage, Error> {
    let parsed: WireModelListPage =
        serde_json::from_str(payload).map_err(|err| decode_error(err, "model/list"))?;

    let models = parsed
        .data
        .into_iter()
        .filter(|model| !model.hidden)
        .filter_map(|model| {
            let model_id = if model.model.is_empty() {
                model.id
            } else {
                model.model
            };
            let mut efforts = model
                .supported_reasoning_efforts
                .into_iter()
                .map(|effort| KickoffEffortInfo {
                    label: effort_label(&effort.reasoning_effort),
                    id: effort.reasoning_effort,
                })
                .collect::<Vec<_>>();
            efforts.sort_by(|left, right| {
                effort_rank(&left.id)
                    .cmp(&effort_rank(&right.id))
                    .then_with(|| left.id.cmp(&right.id))
            });
            efforts.dedup_by(|left, right| left.id == right.id);
            if model_id.is_empty() || efforts.is_empty() {
                return None;
            }
            let label = if model.display_name.is_empty() {
                model_id.clone()
            } else {
                model.display_name
            };
            Some(KickoffModelInfo::new("openai", model_id, label, efforts))
        })
        .collect();

    Ok(KickoffModelPage {
        models,
        next_cursor: parsed.next_cursor,
    })
}

fn effort_rank(effort: &str) -> u8 {
    match effort {
        "none" => 0,
        "minimal" => 1,
        "low" => 2,
        "medium" => 3,
        "high" => 4,
        "xhigh" => 5,
        "max" => 6,
        "ultra" => 7,
        "persistent" => 8,
        _ => u8::MAX,
    }
}

fn effort_label(effort: &str) -> String {
    match effort {
        "none" => "None".to_string(),
        "minimal" => "Minimal".to_string(),
        "low" => "Low".to_string(),
        "medium" => "Medium".to_string(),
        "high" => "High".to_string(),
        "xhigh" => "Extra high".to_string(),
        "max" => "Max".to_string(),
        "ultra" => "Ultra".to_string(),
        "persistent" => "Persistent".to_string(),
        other => other.to_string(),
    }
}

/// Turns a decoded window into the domain shape, labelling it by duration.
fn to_window(wire: WireWindow, is_secondary: bool) -> UsageWindow {
    UsageWindow::new(
        window_label(wire.window_duration_mins, is_secondary),
        wire.used_percent,
        wire.window_duration_mins,
        wire.resets_at,
    )
}

/// Finds the window whose label identifies it, without assuming a slot.
fn find_by_label(windows: &[UsageWindow], label: &str) -> Option<UsageWindow> {
    windows.iter().find(|w| w.label == label).cloned()
}

/// Decodes `account/rateLimits/read` into a snapshot.
///
/// A response that parses but carries no windows is an `Unavailable` snapshot
/// with a reason, not an error: the account is simply not reporting usage.
pub fn decode_rate_limits(
    payload: &str,
    provider: ProviderKind,
    now_ms: i64,
) -> Result<UsageSnapshot, Error> {
    let parsed: WireRateLimitsResponse = serde_json::from_str(payload)
        .map_err(|err| decode_error(err, "account/rateLimits/read"))?;

    let Some(snapshot) = parsed.rate_limits else {
        return Ok(UsageSnapshot::unavailable(
            provider,
            "This account does not report usage limits.",
        ));
    };

    let mut windows = Vec::new();
    if let Some(primary) = snapshot.primary {
        windows.push(to_window(primary, false));
    }
    if let Some(secondary) = snapshot.secondary {
        windows.push(to_window(secondary, true));
    }

    if windows.is_empty() {
        return Ok(UsageSnapshot::unavailable(
            provider,
            "This account does not report usage limits.",
        ));
    }

    // A workspace spend-control stop is a hard block that percentages do not
    // describe, so it wins over the `ordinaryUsageAllowed` tri-state.
    let permission = if snapshot.spend_control_reached == Some(true) {
        UsagePermission::Blocked
    } else {
        match parsed.ordinary_usage_allowed {
            Some(true) => UsagePermission::Allowed,
            Some(false) => UsagePermission::Blocked,
            // Null means "unavailable". Rendering it as Allowed is exactly the
            // mistake the provider documents against.
            None => UsagePermission::Unknown,
        }
    };

    let five_hour = find_by_label(&windows, "5h");
    let weekly = find_by_label(&windows, "weekly");

    Ok(UsageSnapshot {
        provider,
        freshness: freshness_for(now_ms, Some(now_ms)),
        fetched_at: Some(now_ms),
        source: SOURCE_APP_SERVER.to_string(),
        reason: None,
        plan: snapshot.plan_type.as_deref().map(PlanKind::from_wire),
        permission,
        five_hour,
        weekly,
        windows,
    })
}

/// Decodes Codex account token activity without deriving credits or quotas.
pub fn decode_account_usage(payload: &str, now_ms: i64) -> Result<AccountUsage, Error> {
    let parsed: WireAccountUsage =
        serde_json::from_str(payload).map_err(|err| decode_error(err, "account/usage/read"))?;
    let summary = parsed.summary.unwrap_or_default();

    Ok(AccountUsage {
        fetched_at: now_ms,
        summary: AccountUsageSummary {
            total_tokens: summary.lifetime_tokens,
            peak_daily_tokens: summary.peak_daily_tokens,
            longest_running_turn_sec: summary.longest_running_turn_sec,
            current_streak_days: summary.current_streak_days,
            longest_streak_days: summary.longest_streak_days,
            total_requests: None,
        },
        daily_usage_buckets: parsed
            .daily_usage_buckets
            .unwrap_or_default()
            .into_iter()
            .filter_map(|bucket| {
                Some(DailyUsageBucket {
                    start_date: bucket.start_date?,
                    tokens: bucket.tokens,
                })
            })
            .collect(),
        // The app-server account summary totals only; it reports no
        // per-model breakdown (verified against the upstream protocol —
        // the per-model shape exists only on the thread-scoped read).
        models: Vec::new(),
        model_daily_usage: Vec::new(),
        local: None,
        window_days: None,
    })
}

/// Decodes `account/read` into the pieces the UI shows about the account.
///
/// Returns `(plan, requires_openai_auth)`.
///
/// An `apiKey` account carries no plan, which is distinct from an unknown plan:
/// the account exists and is usable, we simply cannot name its tier.
pub fn decode_account(payload: &str) -> Result<(Option<PlanKind>, bool), Error> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Account {
        plan_type: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Response {
        account: Option<Account>,
        requires_openai_auth: bool,
    }

    let parsed: Response =
        serde_json::from_str(payload).map_err(|err| decode_error(err, "account/read"))?;

    let plan = parsed
        .account
        .as_ref()
        .and_then(|account| account.plan_type.as_deref())
        .map(PlanKind::from_wire);

    Ok((plan, parsed.requires_openai_auth))
}

/// Builds the snapshot for an account that is present but signed out.
pub fn decode_signed_out(provider: ProviderKind) -> UsageSnapshot {
    UsageSnapshot::unavailable(provider, "Sign in with `codex login` to see your usage.")
}

fn decode_error(err: serde_json::Error, method: &str) -> Error {
    // The message names the failing method but never echoes the payload, which
    // may contain account details.
    Error::invalid_payload(format!("Could not read the {method} response: {err}"))
}

/// Reads the human-readable message out of a provider error frame, without
/// echoing anything else from the frame.
pub fn decode_error_message(payload: &str) -> String {
    #[derive(Deserialize)]
    struct Frame {
        message: String,
    }
    serde_json::from_str::<Frame>(payload)
        .map(|frame| frame.message)
        .unwrap_or_else(|_| "The provider returned an unreadable error.".to_string())
}

/// Collects `agentMessage` text out of a `turn/completed` notification.
///
/// Codex sends the reply on `item/completed` notifications; this is the
/// fallback path that reads it back off the final turn when those were not
/// captured.
pub fn extract_agent_reply(payload: &str) -> String {
    #[derive(Deserialize)]
    struct Item {
        #[serde(rename = "type")]
        item_type: String,
        text: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Turn {
        items: Vec<Item>,
    }
    #[derive(Deserialize)]
    struct Params {
        turn: Turn,
    }
    #[derive(Deserialize)]
    struct Frame {
        params: Params,
    }

    let Ok(frame) = serde_json::from_str::<Frame>(payload) else {
        return String::new();
    };
    frame
        .params
        .turn
        .items
        .into_iter()
        .filter(|item| item.item_type == "agentMessage")
        .filter_map(|item| item.text)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// Whether a `turn/completed` frame reports success.
pub fn turn_succeeded(payload: &str) -> Result<bool, Error> {
    #[derive(Deserialize)]
    struct Turn {
        status: String,
        error: Option<WireTurnError>,
    }
    #[derive(Deserialize)]
    struct WireTurnError {
        message: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Params {
        turn: Turn,
    }
    #[derive(Deserialize)]
    struct Frame {
        params: Params,
    }

    let frame: Frame = serde_json::from_str(payload)
        .map_err(|err| decode_error(err, "turn/completed notification"))?;

    match frame.params.turn.status.as_str() {
        "completed" => Ok(true),
        other => Err(Error::provider_error(
            frame
                .params
                .turn
                .error
                .map(|error| error.message)
                .unwrap_or_else(|| format!("The turn ended with status `{other}`.")),
        )),
    }
}

/// `true` when the frame is a `turn/completed` notification for this turn id.
///
/// Concurrent turns share the notification stream, so the id must be checked
/// before a frame is treated as ours.
pub fn is_turn_completed_for(payload: &str, turn_id: &str) -> bool {
    #[derive(Deserialize)]
    struct Turn {
        id: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Params {
        turn: Turn,
    }
    #[derive(Deserialize)]
    struct Frame {
        method: String,
        params: Params,
    }

    serde_json::from_str::<Frame>(payload)
        .is_ok_and(|frame| frame.method == "turn/completed" && frame.params.turn.id == turn_id)
}

/// Extracts the error frame's code and message for a typed failure.
pub fn decode_error_frame(payload: &str) -> Error {
    #[derive(Deserialize)]
    struct ErrBody {
        code: i64,
        message: String,
    }
    #[derive(Deserialize)]
    struct Frame {
        error: ErrBody,
    }

    match serde_json::from_str::<Frame>(payload) {
        Ok(frame) => {
            // -32600 is the provider's generic "bad request / not initialised"
            // code and is never actionable to a user on its own.
            if frame.error.code == -32600 {
                Error::provider_error(frame.error.message)
            } else {
                Error::provider_error(format!(
                    "{} (code {})",
                    frame.error.message, frame.error.code
                ))
            }
        }
        Err(_) => Error::provider_error(decode_error_message(payload)),
    }
}

/// A real payload captured from `codex app-server`, used verbatim by the tests
/// below so they cannot drift from what the provider actually sends.
#[cfg(test)]
const LIVE_RATE_LIMITS: &str = r#"{"ordinaryUsageAllowed":true,"rateLimits":{"limitId":"codex","limitName":null,"normalModelSlug":null,"primary":{"usedPercent":0,"windowDurationMins":300,"resetsAt":1791561936},"secondary":{"usedPercent":54,"windowDurationMins":10080,"resetsAt":1791955544},"credits":{"hasCredits":false,"unlimited":false,"balance":null},"individualLimit":null,"spendControlReached":false,"planType":"team","rateLimitReachedType":null},"rateLimitsByLimitId":{"codex":{"limitId":"codex","primary":{"usedPercent":0,"windowDurationMins":300,"resetsAt":1791561936},"secondary":{"usedPercent":54,"windowDurationMins":10080,"resetsAt":1791955544},"planType":"team"}},"rateLimitResetCredits":{"availableCount":2,"credits":[]}}"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::domain::Freshness;

    const NOW: i64 = 1_791_543_935_000;

    #[test]
    fn decodes_the_live_five_hour_window() {
        let snapshot = decode_rate_limits(LIVE_RATE_LIMITS, ProviderKind::Codex, NOW)
            .expect("decodes a real payload");
        let five = snapshot.five_hour.expect("a 5h window");
        assert_eq!(five.used_percent, 0);
        assert_eq!(five.duration_mins, Some(300));
        assert_eq!(five.resets_at, Some(1_791_561_936));
        assert_eq!(five.remaining_percent, 100);
    }

    #[test]
    fn decodes_the_weekly_window_separately() {
        let snapshot =
            decode_rate_limits(LIVE_RATE_LIMITS, ProviderKind::Codex, NOW).expect("decodes");
        let weekly = snapshot.weekly.expect("a weekly window");
        assert_eq!(weekly.used_percent, 54);
        assert_eq!(weekly.duration_mins, Some(10_080));
    }

    #[test]
    fn decodes_reported_activity_summary_and_daily_buckets() {
        let payload = r#"{"summary":{"lifetimeTokens":1234567,"peakDailyTokens":45678,"longestRunningTurnSec":540,"currentStreakDays":8,"longestStreakDays":14},"dailyUsageBuckets":[{"startDate":"2026-10-09","tokens":12345},{"startDate":"2026-10-10","tokens":null}]}"#;
        let usage = decode_account_usage(payload, NOW).expect("decodes");

        assert_eq!(usage.summary.total_tokens, Some(1_234_567));
        assert_eq!(usage.summary.peak_daily_tokens, Some(45_678));
        assert_eq!(usage.summary.longest_running_turn_sec, Some(540));
        assert_eq!(usage.summary.current_streak_days, Some(8));
        assert_eq!(usage.summary.longest_streak_days, Some(14));
        assert_eq!(usage.daily_usage_buckets.len(), 2);
        assert_eq!(usage.daily_usage_buckets[0].tokens, Some(12_345));
        assert_eq!(usage.daily_usage_buckets[1].tokens, None);
        assert_eq!(usage.fetched_at, NOW);
    }

    #[test]
    fn missing_activity_summary_fields_remain_unknown() {
        let usage = decode_account_usage(r#"{"summary":null,"dailyUsageBuckets":null}"#, NOW)
            .expect("nullable response decodes");

        assert_eq!(usage.summary.total_tokens, None);
        assert_eq!(usage.summary.current_streak_days, None);
        assert!(usage.daily_usage_buckets.is_empty());
    }

    #[test]
    fn labels_the_five_hour_window_by_duration_not_by_slot() {
        // A payload whose 5h window arrives in `secondary` must still be found.
        let swapped = r#"{"ordinaryUsageAllowed":true,"rateLimits":{
            "primary":{"usedPercent":54,"windowDurationMins":10080,"resetsAt":1},
            "secondary":{"usedPercent":7,"windowDurationMins":300,"resetsAt":2},
            "planType":"pro"}}"#;
        let snapshot = decode_rate_limits(swapped, ProviderKind::Codex, NOW).expect("decodes");
        assert_eq!(snapshot.five_hour.expect("5h").used_percent, 7);
        assert_eq!(snapshot.weekly.expect("weekly").used_percent, 54);
    }

    #[test]
    fn marks_a_fresh_reading_live_with_provenance() {
        let snapshot =
            decode_rate_limits(LIVE_RATE_LIMITS, ProviderKind::Codex, NOW).expect("decodes");
        assert_eq!(snapshot.freshness, Freshness::Live);
        assert_eq!(snapshot.fetched_at, Some(NOW));
        assert_eq!(snapshot.source, SOURCE_APP_SERVER);
        assert_eq!(snapshot.reason, None);
    }

    #[test]
    fn decodes_the_plan() {
        let snapshot =
            decode_rate_limits(LIVE_RATE_LIMITS, ProviderKind::Codex, NOW).expect("decodes");
        assert_eq!(snapshot.plan, Some(PlanKind::Team));
    }

    #[test]
    fn ordinary_usage_allowed_true_is_allowed() {
        let snapshot =
            decode_rate_limits(LIVE_RATE_LIMITS, ProviderKind::Codex, NOW).expect("decodes");
        assert_eq!(snapshot.permission, UsagePermission::Allowed);
    }

    #[test]
    fn ordinary_usage_allowed_false_is_blocked() {
        let payload = r#"{"ordinaryUsageAllowed":false,"rateLimits":{"primary":{"usedPercent":100,"windowDurationMins":300}}}"#;
        let snapshot = decode_rate_limits(payload, ProviderKind::Codex, NOW).expect("decodes");
        assert_eq!(snapshot.permission, UsagePermission::Blocked);
    }

    #[test]
    fn a_missing_permission_is_unknown_never_allowed() {
        // The provider documents that null means "unavailable"; rendering it as
        // healthy is the bug this guards against.
        let payload = r#"{"rateLimits":{"primary":{"usedPercent":10,"windowDurationMins":300}}}"#;
        let snapshot = decode_rate_limits(payload, ProviderKind::Codex, NOW).expect("decodes");
        assert_eq!(snapshot.permission, UsagePermission::Unknown);
    }

    #[test]
    fn a_spend_control_stop_overrides_an_allowed_flag() {
        let payload = r#"{"ordinaryUsageAllowed":true,"rateLimits":{"primary":{"usedPercent":3,"windowDurationMins":300},"spendControlReached":true}}"#;
        let snapshot = decode_rate_limits(payload, ProviderKind::Codex, NOW).expect("decodes");
        assert_eq!(snapshot.permission, UsagePermission::Blocked);
    }

    #[test]
    fn no_windows_is_unavailable_with_a_reason() {
        let payload =
            r#"{"ordinaryUsageAllowed":true,"rateLimits":{"primary":null,"secondary":null}}"#;
        let snapshot = decode_rate_limits(payload, ProviderKind::Codex, NOW).expect("decodes");
        assert_eq!(snapshot.freshness, Freshness::Unavailable);
        assert!(snapshot.reason.is_some());
        assert!(snapshot.five_hour.is_none());
    }

    #[test]
    fn a_null_rate_limits_object_is_unavailable_not_an_error() {
        let snapshot = decode_rate_limits(r#"{"rateLimits":null}"#, ProviderKind::Codex, NOW)
            .expect("decodes");
        assert_eq!(snapshot.freshness, Freshness::Unavailable);
    }

    #[test]
    fn an_unknown_plan_degrades_instead_of_failing() {
        let payload = r#"{"rateLimits":{"primary":{"usedPercent":1,"windowDurationMins":300},"planType":"brand_new_plan"}}"#;
        let snapshot = decode_rate_limits(payload, ProviderKind::Codex, NOW).expect("decodes");
        assert_eq!(snapshot.plan, Some(PlanKind::Unknown));
    }

    #[test]
    fn out_of_range_percentages_are_clamped() {
        let payload = r#"{"rateLimits":{"primary":{"usedPercent":140,"windowDurationMins":300}}}"#;
        let snapshot = decode_rate_limits(payload, ProviderKind::Codex, NOW).expect("decodes");
        assert_eq!(snapshot.five_hour.expect("5h").used_percent, 100);
    }

    #[test]
    fn malformed_json_is_a_typed_error() {
        let err = decode_rate_limits("{not json", ProviderKind::Codex, NOW).expect_err("must fail");
        assert_eq!(err.kind, crate::shared::error::ErrorKind::InvalidPayload);
    }

    #[test]
    fn an_unknown_field_does_not_break_the_decode() {
        // A provider upgrade adding a field must not blank the dashboard.
        let payload = r#"{"ordinaryUsageAllowed":true,"somethingNew":42,"rateLimits":{"primary":{"usedPercent":5,"windowDurationMins":300,"brandNew":true},"planType":"pro"}}"#;
        let snapshot = decode_rate_limits(payload, ProviderKind::Codex, NOW).expect("decodes");
        assert_eq!(snapshot.five_hour.expect("5h").used_percent, 5);
    }

    #[test]
    fn decodes_a_chatgpt_account() {
        let payload = r#"{"account":{"type":"chatgpt","email":"a@b.c","planType":"pro"},"requiresOpenaiAuth":false}"#;
        let (plan, requires_auth) = decode_account(payload).expect("decodes");
        assert_eq!(plan, Some(PlanKind::Pro));
        assert!(!requires_auth);
    }

    #[test]
    fn decodes_available_models_and_their_efforts() {
        let payload = r#"{"data":[
            {"id":"gpt-6-luna","model":"gpt-6-luna","displayName":"GPT-6 Luna","hidden":false,
             "supportedReasoningEfforts":[
                {"reasoningEffort":"high","description":"High"},
                {"reasoningEffort":"minimal","description":"Minimal"}
             ]},
            {"id":"hidden","model":"hidden","displayName":"Hidden","hidden":true,
             "supportedReasoningEfforts":[{"reasoningEffort":"minimal","description":"Minimal"}]}
        ],"nextCursor":"next-page"}"#;

        let page = decode_model_list_page(payload).expect("decodes");

        assert_eq!(page.next_cursor.as_deref(), Some("next-page"));
        assert_eq!(page.models.len(), 1);
        assert_eq!(page.models[0].id, "gpt-6-luna");
        assert_eq!(page.models[0].label, "GPT-6 Luna");
        assert_eq!(
            page.models[0]
                .efforts
                .iter()
                .map(|effort| effort.id.as_str())
                .collect::<Vec<_>>(),
            vec!["minimal", "high"]
        );
    }

    #[test]
    fn an_unknown_plan_on_the_account_degrades_to_unknown() {
        let payload =
            r#"{"account":{"type":"chatgpt","planType":"brand_new"},"requiresOpenaiAuth":false}"#;
        let (plan, _) = decode_account(payload).expect("decodes");
        assert_eq!(plan, Some(PlanKind::Unknown));
    }

    #[test]
    fn an_api_key_account_has_no_plan() {
        // An API-key account is usable but has no tier, which is distinct from
        // a tier we failed to recognise.
        let payload = r#"{"account":{"type":"apiKey"},"requiresOpenaiAuth":true}"#;
        let (plan, requires_auth) = decode_account(payload).expect("decodes");
        assert_eq!(plan, None);
        assert!(requires_auth);
    }

    #[test]
    fn a_signed_out_account_reports_the_reason() {
        let snapshot = decode_signed_out(ProviderKind::Codex);
        assert_eq!(snapshot.freshness, Freshness::Unavailable);
        assert!(snapshot.reason.unwrap().contains("codex login"));
    }

    #[test]
    fn recognises_a_completed_turn() {
        let frame = r#"{"method":"turn/completed","params":{"threadId":"t1","turn":{"id":"turn-1","status":"completed","items":[]}}}"#;
        assert!(turn_succeeded(frame).expect("parses"));
        assert!(is_turn_completed_for(frame, "turn-1"));
    }

    #[test]
    fn a_failed_turn_reports_the_provider_message() {
        let frame = r#"{"method":"turn/completed","params":{"threadId":"t1","turn":{"id":"turn-1","status":"failed","error":{"message":"usage limit reached"},"items":[]}}}"#;
        let err = turn_succeeded(frame).expect_err("must fail");
        assert_eq!(err.message, "usage limit reached");
    }

    #[test]
    fn a_completed_turn_for_another_id_is_not_ours() {
        let frame = r#"{"method":"turn/completed","params":{"threadId":"t1","turn":{"id":"turn-2","status":"completed","items":[]}}}"#;
        assert!(!is_turn_completed_for(frame, "turn-1"));
    }

    #[test]
    fn extracts_the_agent_reply() {
        let frame = r#"{"method":"turn/completed","params":{"threadId":"t1","turn":{"id":"turn-1","status":"completed","items":[{"type":"agentMessage","text":"Hello!"},{"type":"reasoning","text":"thinking"}]}}}"#;
        assert_eq!(extract_agent_reply(frame), "Hello!");
    }

    #[test]
    fn a_turn_with_no_agent_message_yields_an_empty_reply() {
        let frame = r#"{"method":"turn/completed","params":{"threadId":"t1","turn":{"id":"turn-1","status":"completed","items":[{"type":"reasoning","text":"thinking"}]}}}"#;
        assert_eq!(extract_agent_reply(frame), "");
    }

    #[test]
    fn recognises_an_error_frame() {
        let err =
            decode_error_frame(r#"{"id":3,"error":{"code":-32600,"message":"not initialized"}}"#);
        assert!(err.message.contains("not initialized"));
    }

    #[test]
    fn decodes_an_error_frame_with_its_code() {
        let err =
            decode_error_frame(r#"{"id":3,"error":{"code":-32601,"message":"Method not found"}}"#);
        assert!(err.message.contains("Method not found"));
        assert!(err.message.contains("-32601"));
    }

    #[test]
    fn a_generic_provider_code_stays_readable() {
        // -32600 carries no useful code detail for a user.
        let err = decode_error_frame(
            r#"{"id":3,"error":{"code":-32600,"message":"codex account authentication required"}}"#,
        );
        assert_eq!(err.message, "codex account authentication required");
    }
}
