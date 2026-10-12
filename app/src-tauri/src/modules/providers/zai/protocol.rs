//! Pure decoders for the Z.AI / Zhipu coding-plan quota endpoint.
//!
//! The endpoint is `GET /api/monitor/usage/quota/limit`. It is not in the
//! public docs pages; the contract comes from Z.AI's own reference client and
//! usage doc (`zai-org/ZCode`, `zai-org/zai-coding-plugins`), and the fixture
//! below is a verbatim reply captured against the live endpoint with the key
//! OpenCode stores.
//!
//! Two traps the vendor document calls out, both handled here:
//! * business errors arrive inside HTTP 200 (`success: false`, `code != 200`),
//!   so the envelope is validated before any field is trusted;
//! * the credential goes in `Authorization` **without** a `Bearer` prefix —
//!   with the prefix the endpoint rejects authentication.

use serde::Deserialize;

use crate::shared::domain::{
    AccountUsage, AccountUsageSummary, DailyUsageBucket, Freshness, KickoffEffortInfo, ModelUsage,
    PlanKind, ProviderKind, UsagePermission, UsageSnapshot, UsageWindow,
};
use crate::shared::error::{Error, ErrorKind};

/// The vendor's quota path, appended to the region host.
pub const QUOTA_PATH: &str = "/api/monitor/usage/quota/limit";

/// The vendor's historical model-usage path, appended to the region host.
pub const MODEL_USAGE_PATH: &str = "/api/monitor/usage/model-usage";

/// How many days of history one analytics read asks for. The endpoint rejects
/// spans above 31, and 30 keeps every request legal without chunking.
const ANALYTICS_WINDOW_DAYS: i64 = 30;

/// Asia/Shanghai's fixed offset. The vendor interprets monitor request ranges
/// and bucket labels in UTC+8; the offset is permanent there (no DST).
const UTC8_OFFSET_SECS: i64 = 8 * 3_600;

#[derive(Debug, Deserialize)]
struct WireEnvelope {
    code: i64,
    msg: String,
    #[serde(default)]
    data: Option<WireData>,
    #[serde(default)]
    success: bool,
}

#[derive(Debug, Default, Deserialize)]
struct WireData {
    #[serde(default)]
    limits: Vec<WireLimit>,
    #[serde(default)]
    level: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WireLimit {
    /// `CREDIT_LIMIT` (formerly `TOKENS_LIMIT`) or `TIME_LIMIT`; the window
    /// geometry comes from `unit` × `number`, so the type is not matched on.
    #[serde(rename = "type")]
    #[allow(dead_code)]
    kind: String,
    unit: i64,
    number: i64,
    /// Percentage **already used**, per the vendor doc.
    #[serde(default)]
    percentage: Option<i64>,
    /// Milliseconds since the epoch, and explicitly optional: a missing field
    /// must render "reset time unknown", never a guessed one.
    #[serde(default)]
    #[serde(rename = "nextResetTime")]
    next_reset_time: Option<i64>,
}

/// Decodes a quota reply into a snapshot.
pub fn decode_quota(
    payload: &str,
    provider: ProviderKind,
    now_ms: i64,
) -> Result<UsageSnapshot, Error> {
    let wire: WireEnvelope = serde_json::from_str(payload).map_err(|error| {
        Error::new(
            ErrorKind::InvalidPayload,
            format!("The Z.AI usage reply could not be decoded ({error})."),
        )
    })?;

    if !wire.success || wire.code != 200 {
        return Err(Error::new(
            ErrorKind::ProviderError,
            format!("Z.AI refused the usage read ({}).", wire.msg),
        ));
    }

    let data = wire.data.unwrap_or_default();
    let mut windows = Vec::new();
    let mut five_hour = None;
    let mut weekly = None;

    for limit in data.limits {
        let Some(minutes) = unit_minutes(limit.unit).map(|mins| mins * limit.number.max(0)) else {
            continue;
        };
        let used = limit.percentage.unwrap_or(0).clamp(0, 100) as i32;
        let window = UsageWindow::new(
            crate::shared::domain::window_label(Some(minutes), false),
            used,
            Some(minutes),
            limit.next_reset_time.map(|ms| ms / 1000),
        );
        if window.label == "5h" && five_hour.is_none() {
            five_hour = Some(window.clone());
        }
        if window.label == "weekly" && weekly.is_none() {
            weekly = Some(window.clone());
        }
        windows.push(window);
    }

    Ok(UsageSnapshot {
        provider,
        freshness: Freshness::Live,
        fetched_at: Some(now_ms),
        source: provider.source().to_string(),
        reason: None,
        plan: data.level.as_deref().map(PlanKind::from_wire),
        // The quota endpoint answering means the account is usable; an
        // exhausted or rejected account arrives as an error envelope instead,
        // which decodes to an explicit unavailable state. Leaving this
        // `Unknown` would mute every reading — the UI renders unknown as
        // never-healthy, and a plan reporting 19% used is healthy.
        permission: UsagePermission::Allowed,
        windows,
        five_hour,
        weekly,
    })
}

/// The vendor's unit codes: hours, months, weeks. Anything else is a window
/// this app cannot name, so it is skipped rather than mislabelled.
fn unit_minutes(unit: i64) -> Option<i64> {
    match unit {
        3 => Some(60),
        5 => Some(30 * 24 * 60),
        6 => Some(7 * 24 * 60),
        _ => None,
    }
}

/// A business-level authentication refusal, decoded from the vendor envelope.
///
/// The key belongs to OpenCode, so the honest recovery hint names OpenCode,
/// not this app.
pub fn decode_auth_failure(provider: ProviderKind) -> UsageSnapshot {
    UsageSnapshot::unavailable(
        provider,
        "Z.AI rejected the credential OpenCode stored for the coding plan. Reconnect it in OpenCode.",
    )
}

/// Whether a refused envelope means the credential was rejected.
pub fn is_auth_refusal(payload: &str) -> bool {
    serde_json::from_str::<WireEnvelope>(payload)
        .map(|wire| wire.code == 401)
        .unwrap_or(false)
}

#[derive(Debug, Deserialize)]
struct WireModelUsage {
    code: i64,
    msg: String,
    #[serde(default)]
    data: Option<WireModelUsageData>,
    #[serde(default)]
    success: bool,
}

#[derive(Debug, Default, Deserialize)]
struct WireModelUsageData {
    /// Bucket stamps paired by index with `tokens_usage`. The live endpoint
    /// sends `YYYY-MM-DD` strings (its own UTC+8 bucket labels); the integer
    /// unix-seconds form is kept because the shape is unpublished and an OSS
    /// client pinned that variant.
    #[serde(default)]
    x_time: Vec<WireStamp>,
    #[serde(default)]
    #[serde(rename = "tokensUsage")]
    tokens_usage: Vec<u64>,
    #[serde(default)]
    #[serde(rename = "modelCallCount")]
    model_call_count: Vec<u64>,
    #[serde(default)]
    #[serde(rename = "totalUsage")]
    total_usage: Option<WireTotalUsage>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum WireStamp {
    /// The live shape: the vendor's own bucket label.
    Date(String),
    /// The shape openusage pinned: unix seconds.
    EpochSecs(i64),
}

impl WireStamp {
    fn date(&self) -> String {
        match self {
            WireStamp::Date(value) => value.chars().take(10).collect(),
            WireStamp::EpochSecs(secs) => utc8_date(*secs),
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct WireTotalUsage {
    #[serde(default)]
    #[serde(rename = "totalModelCallCount")]
    total_model_call_count: Option<u64>,
    #[serde(default)]
    #[serde(rename = "totalTokensUsage")]
    total_tokens_usage: Option<u64>,
    /// Per-model rollup rows. The vendor reports display-case names
    /// (`GLM-5.3`); `id` normalises to the catalog slug for price joins.
    #[serde(default)]
    #[serde(rename = "modelSummaryList")]
    model_summary_list: Vec<WireModelSummary>,
}

#[derive(Debug, Deserialize)]
struct WireModelSummary {
    #[serde(rename = "modelName")]
    model_name: String,
    #[serde(rename = "totalTokens")]
    total_tokens: u64,
    #[serde(default)]
    sort_order: Option<i64>,
}

/// The query string for one analytics read: the model-usage path plus a
/// 30-day range ending at `now_ms`.
///
/// The vendor rejects spans above 31 days and interprets the range in
/// Asia/Shanghai, so both bounds are formatted in UTC+8 with the space and
/// colons percent-encoded exactly as the vendor's own client encodes them.
pub fn model_usage_query(now_ms: i64) -> String {
    let end_secs = now_ms / 1000;
    let start_secs = end_secs - ANALYTICS_WINDOW_DAYS * 86_400;
    format!(
        "{MODEL_USAGE_PATH}?startTime={}&endTime={}",
        encode_query_value(format_utc8(start_secs)),
        encode_query_value(format_utc8(end_secs)),
    )
}

fn encode_query_value(value: String) -> String {
    value.replace(' ', "%20").replace(':', "%3A")
}

/// A UTC+8 wall-clock timestamp in the vendor's `yyyy-MM-dd HH:mm:ss` form.
fn format_utc8(unix_secs: i64) -> String {
    let (year, month, day, hour, minute, second) = civil_parts(unix_secs + UTC8_OFFSET_SECS);
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}")
}

/// The UTC+8 calendar date of a unix-seconds stamp, the vendor's bucket label.
fn utc8_date(unix_secs: i64) -> String {
    let (year, month, day, ..) = civil_parts(unix_secs + UTC8_OFFSET_SECS);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Splits a unix-seconds stamp into civil parts, valid for any timestamp
/// after 1970 (days-from-epoch civil algorithm, no timezone database).
fn civil_parts(unix_secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = unix_secs.div_euclid(86_400);
    let secs_of_day = unix_secs.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days, shifted to the March-based year so
    // leap days land at the end of the cycle.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if month <= 2 { year + 1 } else { year };
    (
        year,
        month,
        day,
        (secs_of_day / 3_600) as u32,
        ((secs_of_day % 3_600) / 60) as u32,
        (secs_of_day % 60) as u32,
    )
}

/// Decodes a `model-usage` reply into account analytics.
///
/// The shape is the rollup-era one pinned in the committed research: paired
/// `x_time` / `tokensUsage` series form the daily buckets, `totalUsage`
/// carries the headline rollups, and the per-model lists are deliberately not
/// summed in — a repeated summary must never be counted twice, and token
/// totals must never surface as request counts.
pub fn decode_model_usage(payload: &str, now_ms: i64) -> Result<AccountUsage, Error> {
    let wire: WireModelUsage = serde_json::from_str(payload).map_err(|error| {
        Error::new(
            ErrorKind::InvalidPayload,
            format!("The Z.AI analytics reply could not be decoded ({error})."),
        )
    })?;

    if !wire.success || wire.code != 200 {
        return Err(Error::new(
            ErrorKind::ProviderError,
            format!("Z.AI refused the analytics read ({}).", wire.msg),
        ));
    }

    let data = wire.data.unwrap_or_default();
    let mut buckets: Vec<DailyUsageBucket> = Vec::new();
    for (stamp, tokens) in data.x_time.iter().zip(data.tokens_usage.iter()) {
        let date = stamp.date();
        match buckets.last_mut() {
            // Hourly buckets for a short span merge into their day, so the
            // chart keeps one bar per day whatever the server's granularity.
            Some(last) if last.start_date == date => {
                last.tokens = Some(last.tokens.unwrap_or(0).saturating_add(*tokens));
            }
            _ => buckets.push(DailyUsageBucket {
                start_date: date,
                tokens: Some(*tokens),
            }),
        }
    }
    buckets.sort_by(|left, right| left.start_date.cmp(&right.start_date));

    let series_tokens: u64 = data
        .tokens_usage
        .iter()
        .fold(0u64, |sum, tokens| sum.saturating_add(*tokens));
    let series_calls: u64 = data
        .model_call_count
        .iter()
        .fold(0u64, |sum, calls| sum.saturating_add(*calls));
    let peak = buckets.iter().filter_map(|bucket| bucket.tokens).max();
    let (current_streak, longest_streak) = streak_days(&buckets);

    let mut ranked: Vec<(Option<i64>, ModelUsage)> = data
        .total_usage
        .as_ref()
        .map(|total| total.model_summary_list.as_slice())
        .unwrap_or(&[])
        .iter()
        .map(|row| {
            (
                row.sort_order,
                ModelUsage {
                    id: row.model_name.to_lowercase(),
                    display_name: row.model_name.clone(),
                    tokens: row.total_tokens,
                    requests: None,
                },
            )
        })
        .collect();
    // The vendor's own ranking (`sortOrder`, the plan's primary model first)
    // is the reported truth; unranked rows keep arrival order after ranked
    // ones, with the name as a deterministic tiebreak.
    ranked.sort_by(|left, right| {
        let left_rank = left.0.unwrap_or(i64::MAX);
        let right_rank = right.0.unwrap_or(i64::MAX);
        left_rank
            .cmp(&right_rank)
            .then_with(|| left.1.display_name.cmp(&right.1.display_name))
    });
    let models = ranked
        .into_iter()
        .map(|(_, model)| model)
        .collect::<Vec<_>>();

    Ok(AccountUsage {
        fetched_at: now_ms,
        summary: AccountUsageSummary {
            total_tokens: data
                .total_usage
                .as_ref()
                .and_then(|total| total.total_tokens_usage)
                .or((!buckets.is_empty()).then_some(series_tokens)),
            peak_daily_tokens: peak,
            longest_running_turn_sec: None,
            current_streak_days: current_streak,
            longest_streak_days: longest_streak,
            total_requests: data
                .total_usage
                .as_ref()
                .and_then(|total| total.total_model_call_count)
                .or((!data.model_call_count.is_empty()).then_some(series_calls)),
        },
        daily_usage_buckets: buckets,
        models,
        local: None,
        window_days: Some(ANALYTICS_WINDOW_DAYS as u64),
    })
}

/// Consecutive activity-day runs over the daily buckets, most recent last.
///
/// One trailing inactive day is grace — the newest bucket may simply not have
/// filled yet — but two mean the run is over. Empty history is `None` (not
/// reported) rather than a zero that looks like a measurement.
fn streak_days(buckets: &[DailyUsageBucket]) -> (Option<u64>, Option<u64>) {
    if buckets.is_empty() {
        return (None, None);
    }
    let active: Vec<bool> = buckets
        .iter()
        .map(|bucket| bucket.tokens.unwrap_or(0) > 0)
        .collect();

    let mut longest: u64 = 0;
    let mut run: u64 = 0;
    for is_active in &active {
        run = if *is_active { run + 1 } else { 0 };
        longest = longest.max(run);
    }

    // The current run is counted over the series with at most one trailing
    // inactive day dropped, so "no activity yet on the newest day" does not
    // erase an ongoing streak while a real gap ends it.
    let grace = usize::from(active.last() == Some(&false));
    let mut current: u64 = 0;
    for is_active in active[..active.len() - grace].iter().rev() {
        if !*is_active {
            break;
        }
        current += 1;
    }
    (Some(current), Some(longest))
}

// ---------------------------------------------------------------------------
// Scheduled kickoff
// ---------------------------------------------------------------------------

/// The reply budget for a kickoff. The prompt opens a window; the reply is
/// context only.
pub const KICKOFF_MAX_TOKENS: i64 = 32;

/// Builds the chat-completions request body for the scheduled kickoff.
///
/// The endpoint is the OpenAI-compatible one on the plan's coding base, so
/// the shape is the vendor's documented chat shape at its smallest.
pub fn kickoff_efforts(model: &str) -> Vec<KickoffEffortInfo> {
    match model {
        "glm-5.2" => ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
            .into_iter()
            .map(|effort| KickoffEffortInfo::new(effort, effort_label(effort)))
            .collect(),
        "glm-5.3" | "glm-5.3-flash" => ["low", "high", "max"]
            .into_iter()
            .map(|effort| KickoffEffortInfo::new(effort, effort_label(effort)))
            .collect(),
        _ => vec![KickoffEffortInfo::new(
            "provider-default",
            "Provider default",
        )],
    }
}

fn effort_label(effort: &str) -> &'static str {
    match effort {
        "none" => "None",
        "minimal" => "Minimal",
        "low" => "Low",
        "medium" => "Medium",
        "high" => "High",
        "xhigh" => "Extra high",
        "max" => "Max",
        _ => "Provider default",
    }
}

pub fn kickoff_body(model: &str, prompt: &str, effort: &str) -> String {
    let mut body = serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": prompt }],
        "max_tokens": KICKOFF_MAX_TOKENS,
        "stream": false,
    });
    match effort {
        "none" | "minimal" => body["thinking"] = serde_json::json!({ "type": "disabled" }),
        "low" | "medium" | "high" | "xhigh" | "max" => {
            body["thinking"] = serde_json::json!({ "type": "enabled" });
            body["reasoning_effort"] = serde_json::Value::String(effort.to_string());
        }
        _ => {}
    }
    body.to_string()
}

/// Extracts the agent reply text from a chat-completions response.
pub fn decode_kickoff_reply(payload: &str) -> Result<String, Error> {
    let wire: serde_json::Value = serde_json::from_str(payload).map_err(|error| {
        Error::new(
            ErrorKind::InvalidPayload,
            format!("The kickoff reply could not be decoded ({error})."),
        )
    })?;
    Ok(wire["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_kickoff_body_is_the_documented_chat_shape_at_its_smallest() {
        let body = kickoff_body("glm-5.3-flash", "hi", "low");
        let value: serde_json::Value = serde_json::from_str(&body).expect("json");
        assert_eq!(value["model"], "glm-5.3-flash");
        assert_eq!(value["messages"][0]["role"], "user");
        assert_eq!(value["messages"][0]["content"], "hi");
        assert_eq!(value["max_tokens"], KICKOFF_MAX_TOKENS);
        assert_eq!(value["stream"], false);
        assert_eq!(value["thinking"]["type"], "enabled");
        assert_eq!(value["reasoning_effort"], "low");
    }

    #[test]
    fn models_without_documented_effort_controls_keep_the_provider_default() {
        let body = kickoff_body("glm-4.7", "hi", "provider-default");
        let value: serde_json::Value = serde_json::from_str(&body).expect("json");
        assert!(value.get("reasoning_effort").is_none());
        assert!(value.get("thinking").is_none());
    }

    #[test]
    fn effort_choices_follow_each_glm_model_and_put_the_lowest_first() {
        let glm_52 = kickoff_efforts("glm-5.2");
        let glm_53 = kickoff_efforts("glm-5.3");
        let flash = kickoff_efforts("glm-5.3-flash");

        assert_eq!(
            glm_52.first().map(|effort| effort.id.as_str()),
            Some("none")
        );
        assert_eq!(glm_53.first().map(|effort| effort.id.as_str()), Some("low"));
        assert_eq!(flash.first().map(|effort| effort.id.as_str()), Some("low"));
        assert_eq!(kickoff_efforts("glm-4.7").len(), 1);
    }

    #[test]
    fn the_kickoff_reply_is_the_first_choice_content() {
        let payload = r#"{"choices":[{"message":{"role":"assistant","content":"Hello!"}}]}"#;
        assert_eq!(decode_kickoff_reply(payload).expect("decodes"), "Hello!");
    }

    #[test]
    fn a_kickoff_reply_without_text_decodes_to_empty_not_an_error() {
        let payload = r#"{"choices":[{"message":{"content":null}}]}"#;
        assert_eq!(decode_kickoff_reply(payload).expect("decodes"), "");
    }

    #[test]
    fn garbage_kickoff_replies_are_rejected() {
        assert!(decode_kickoff_reply("not json").is_err());
    }

    /// A verbatim reply from the live endpoint (values as captured; the key
    /// never appears in a payload).
    const LIVE_QUOTA: &str = r#"{
        "code": 200,
        "msg": "Operation successful",
        "data": {
            "limits": [
                {
                    "type": "CREDIT_LIMIT",
                    "unit": 3,
                    "number": 5,
                    "usage": 12000,
                    "currentValue": 1922,
                    "remaining": 10077,
                    "percentage": 16,
                    "nextResetTime": 1791647645103
                },
                {
                    "type": "CREDIT_LIMIT",
                    "unit": 6,
                    "number": 1,
                    "usage": 60000,
                    "currentValue": 21380,
                    "remaining": 38619,
                    "percentage": 35,
                    "nextResetTime": 1791790768984
                }
            ],
            "level": "pro"
        },
        "success": true
    }"#;

    #[test]
    fn decodes_the_live_reply_into_named_windows() {
        let snapshot = decode_quota(LIVE_QUOTA, ProviderKind::Zai, 1_000).expect("decodes");
        assert_eq!(snapshot.provider, ProviderKind::Zai);
        assert_eq!(snapshot.plan, Some(PlanKind::Pro));
        assert_eq!(snapshot.windows.len(), 2);

        let five_hour = snapshot.five_hour.expect("5h window present");
        assert_eq!(five_hour.used_percent, 16);
        assert_eq!(five_hour.remaining_percent, 84);
        assert_eq!(five_hour.duration_mins, Some(300));
        assert_eq!(five_hour.resets_at, Some(1_791_647_645));

        let weekly = snapshot.weekly.expect("weekly window present");
        assert_eq!(weekly.used_percent, 35);
        assert_eq!(weekly.duration_mins, Some(10_080));
    }

    /// A second verbatim live capture, hours after the first, with different
    /// values — pins the mapping against a moving target rather than one
    /// lucky reply.
    const LIVE_QUOTA_LATER: &str = r#"{
        "code": 200,
        "msg": "Operation successful",
        "data": {
            "limits": [
                {
                    "type": "CREDIT_LIMIT",
                    "unit": 3,
                    "number": 5,
                    "usage": 12000,
                    "currentValue": 2318,
                    "remaining": 9681,
                    "percentage": 19,
                    "nextResetTime": 1791665647806
                },
                {
                    "type": "CREDIT_LIMIT",
                    "unit": 6,
                    "number": 1,
                    "usage": 60000,
                    "currentValue": 27896,
                    "remaining": 32103,
                    "percentage": 46,
                    "nextResetTime": 1791790768984
                }
            ],
            "level": "pro"
        },
        "success": true
    }"#;

    #[test]
    fn a_second_live_capture_decodes_with_the_same_rules() {
        // Captured at 2026-10-10T17:48:06Z; the absolute counts independently
        // confirm the direction: 2318/12000 = 19% used matches `percentage`.
        let snapshot = decode_quota(LIVE_QUOTA_LATER, ProviderKind::Zai, 5_000).expect("decodes");
        let five_hour = snapshot.five_hour.expect("5h window present");
        assert_eq!(five_hour.used_percent, 19);
        assert_eq!(five_hour.remaining_percent, 81);
        assert_eq!(five_hour.resets_at, Some(1_791_665_647));

        let weekly = snapshot.weekly.expect("weekly window present");
        assert_eq!(weekly.used_percent, 46);
        assert_eq!(weekly.remaining_percent, 54);
        assert_eq!(weekly.resets_at, Some(1_791_790_768));
    }

    #[test]
    fn a_successful_read_is_allowed_not_unknown() {
        // `unknown` is never rendered as healthy, so a plan reporting 19%
        // used must not arrive as unknown — the muted grey it causes reads
        // as wrong data next to Codex's coloured reading.
        let snapshot = decode_quota(LIVE_QUOTA_LATER, ProviderKind::Zai, 0).expect("decodes");
        assert_eq!(snapshot.permission, UsagePermission::Allowed);
    }

    #[test]
    fn the_stamp_is_the_one_the_caller_passes() {
        // The pipeline passes the clock at read time; the decoder must not
        // invent its own (older) stamp.
        let snapshot = decode_quota(LIVE_QUOTA_LATER, ProviderKind::Zai, 123_456).expect("decodes");
        assert_eq!(snapshot.fetched_at, Some(123_456));
    }

    #[test]
    fn the_tokens_limit_rename_is_irrelevant_because_type_is_ignored() {
        // The vendor renamed TOKENS_LIMIT to CREDIT_LIMIT in 2026; decoding
        // keys off the window geometry so both eras decode identically.
        let legacy = LIVE_QUOTA.replace("CREDIT_LIMIT", "TOKENS_LIMIT");
        let snapshot = decode_quota(&legacy, ProviderKind::Zai, 0).expect("decodes");
        assert_eq!(snapshot.windows.len(), 2);
    }

    #[test]
    fn a_missing_reset_time_is_unknown_not_zero() {
        let payload = r#"{"code":200,"msg":"ok","success":true,"data":{"limits":[
            {"type":"CREDIT_LIMIT","unit":3,"number":5,"percentage":10}],"level":"lite"}}"#;
        let snapshot = decode_quota(payload, ProviderKind::Zai, 0).expect("decodes");
        assert_eq!(snapshot.five_hour.expect("present").resets_at, None);
    }

    #[test]
    fn a_business_error_inside_http_200_is_a_failure() {
        let payload = r#"{"code":401,"msg":"token expired or incorrect","success":false}"#;
        assert!(decode_quota(payload, ProviderKind::Zai, 0).is_err());
        assert!(is_auth_refusal(payload));
    }

    #[test]
    fn a_garbage_payload_is_rejected() {
        assert!(decode_quota("not json", ProviderKind::Zai, 0).is_err());
        assert!(!is_auth_refusal("not json"));
    }

    #[test]
    fn the_lite_tier_maps_to_its_own_plan_kind() {
        let payload =
            r#"{"code":200,"msg":"ok","success":true,"data":{"limits":[],"level":"lite"}}"#;
        let snapshot = decode_quota(payload, ProviderKind::Zai, 0).expect("decodes");
        assert_eq!(snapshot.plan, Some(PlanKind::Lite));
    }

    // -- model-usage (account analytics) ---------------------------------

    /// The rollup-era `model-usage` shape as pinned by two independent OSS
    /// clients against production; values are synthetic, field names are not.
    const MODEL_USAGE: &str = r#"{
        "code": 200,
        "msg": "Operation successful",
        "data": {
            "x_time": [1767225600, 1767312000],
            "modelCallCount": [4, 3],
            "tokensUsage": [700, 500],
            "totalUsage": {
                "totalModelCallCount": 7,
                "totalTokensUsage": 1200,
                "modelSummaryList": [{"modelName": "glm-4.6", "totalTokens": 800}]
            },
            "modelDataList": [
                {"modelName": "glm-4.6", "tokensUsage": [600, 200], "totalTokens": 800}
            ],
            "modelSummaryList": [{"modelName": "glm-4.6", "totalTokens": 800}]
        },
        "success": true
    }"#;

    #[test]
    fn decodes_the_time_series_into_daily_buckets() {
        let usage = decode_model_usage(MODEL_USAGE, 1_000).expect("decodes");
        assert_eq!(usage.window_days, Some(30));
        assert_eq!(usage.fetched_at, 1_000);
        assert_eq!(usage.daily_usage_buckets.len(), 2);
        // 1_767_225_600 s is 2026-01-01T00:00Z; the vendor buckets in UTC+8,
        // and the date is the same either way for day-anchored stamps.
        assert_eq!(usage.daily_usage_buckets[0].start_date, "2026-01-01");
        assert_eq!(usage.daily_usage_buckets[0].tokens, Some(700));
        assert_eq!(usage.daily_usage_buckets[1].start_date, "2026-01-02");
        assert_eq!(usage.daily_usage_buckets[1].tokens, Some(500));
    }

    #[test]
    fn the_rollups_are_the_headline_totals_and_calls_are_not_tokens() {
        let usage = decode_model_usage(MODEL_USAGE, 0).expect("decodes");
        assert_eq!(usage.summary.total_tokens, Some(1_200));
        assert_eq!(usage.summary.total_requests, Some(7));
        assert_eq!(usage.summary.peak_daily_tokens, Some(700));
        // Two consecutive active days in the series.
        assert_eq!(usage.summary.current_streak_days, Some(2));
        assert_eq!(usage.summary.longest_streak_days, Some(2));
        assert_eq!(usage.summary.longest_running_turn_sec, None);
    }

    #[test]
    fn missing_rollups_fall_back_to_the_series_sums() {
        let payload = r#"{"code":200,"msg":"ok","success":true,"data":{
            "x_time": [1767225600, 1767312000],
            "modelCallCount": [4, 3],
            "tokensUsage": [700, 500]
        }}"#;
        let usage = decode_model_usage(payload, 0).expect("decodes");
        assert_eq!(usage.summary.total_tokens, Some(1_200));
        assert_eq!(usage.summary.total_requests, Some(7));
    }

    #[test]
    fn hourly_buckets_for_one_day_merge_into_that_day() {
        let payload = r#"{"code":200,"msg":"ok","success":true,"data":{
            "x_time": [1767225600, 1767229200, 1767312000],
            "tokensUsage": [300, 400, 500]
        }}"#;
        let usage = decode_model_usage(payload, 0).expect("decodes");
        assert_eq!(usage.daily_usage_buckets.len(), 2);
        assert_eq!(usage.daily_usage_buckets[0].tokens, Some(700));
    }

    #[test]
    fn a_trailing_inactive_day_does_not_break_the_current_streak() {
        let payload = r#"{"code":200,"msg":"ok","success":true,"data":{
            "x_time": [1767139200, 1767225600, 1767312000],
            "tokensUsage": [100, 200, 0]
        }}"#;
        let usage = decode_model_usage(payload, 0).expect("decodes");
        assert_eq!(usage.summary.current_streak_days, Some(2));
        assert_eq!(usage.summary.longest_streak_days, Some(2));
    }

    #[test]
    fn two_trailing_inactive_days_end_the_current_streak() {
        let payload = r#"{"code":200,"msg":"ok","success":true,"data":{
            "x_time": [1767139200, 1767225600, 1767312000],
            "tokensUsage": [100, 0, 0]
        }}"#;
        let usage = decode_model_usage(payload, 0).expect("decodes");
        assert_eq!(usage.summary.current_streak_days, Some(0));
        assert_eq!(usage.summary.longest_streak_days, Some(1));
    }

    #[test]
    fn an_empty_series_is_no_data_not_zero() {
        let usage = decode_model_usage(r#"{"code":200,"msg":"ok","success":true,"data":{}}"#, 0)
            .expect("decodes");
        assert!(usage.daily_usage_buckets.is_empty());
        assert_eq!(usage.summary.total_tokens, None);
        assert_eq!(usage.summary.total_requests, None);
        assert_eq!(usage.summary.peak_daily_tokens, None);
        assert_eq!(usage.summary.current_streak_days, None);
    }

    #[test]
    fn a_mismatched_series_ignores_the_extra_stamps() {
        let payload = r#"{"code":200,"msg":"ok","success":true,"data":{
            "x_time": [1767225600, 1767312000],
            "tokensUsage": [700]
        }}"#;
        let usage = decode_model_usage(payload, 0).expect("decodes");
        assert_eq!(usage.daily_usage_buckets.len(), 1);
    }

    #[test]
    fn a_business_error_inside_http_200_is_a_failure_for_analytics_too() {
        let payload = r#"{"code":401,"msg":"token expired or incorrect","success":false}"#;
        assert!(decode_model_usage(payload, 0).is_err());
    }

    #[test]
    fn garbage_is_rejected_by_the_analytics_decoder() {
        assert!(decode_model_usage("not json", 0).is_err());
    }

    #[test]
    fn the_query_asks_for_thirty_days_in_utc8_with_an_encoded_space() {
        // 1_767_225_600_000 ms is 2026-01-01T00:00:00Z, i.e. 08:00 in UTC+8.
        let query = model_usage_query(1_767_225_600_000);
        assert!(query.starts_with(MODEL_USAGE_PATH), "path first: {query}");
        assert!(
            query.contains("startTime=2025-12-02%2008%3A00%3A00"),
            "start is 30 days before the end, UTC+8, encoded: {query}"
        );
        assert!(
            query.contains("endTime=2026-01-01%2008%3A00%3A00"),
            "end is the caller's now, UTC+8, encoded: {query}"
        );
    }

    /// A verbatim live reply captured 2026-10-10 against `model-usage` with
    /// the key OpenCode stores. The live shape differs from the OSS-pinned
    /// one exactly where it matters: `x_time` carries the vendor's own
    /// `YYYY-MM-DD` bucket labels (31 of them for the 30-day ask), and the
    /// reply names its `granularity`.
    const LIVE_MODEL_USAGE: &str = r#"{"code":200,"msg":"Operation successful","data":{"x_time":["2026-09-11","2026-09-12","2026-09-13","2026-09-14","2026-09-15","2026-09-16","2026-09-17","2026-09-18","2026-09-19","2026-09-20","2026-09-21","2026-09-22","2026-09-23","2026-09-24","2026-09-25","2026-09-26","2026-09-27","2026-09-28","2026-09-29","2026-09-30","2026-10-01","2026-10-02","2026-10-03","2026-10-04","2026-10-05","2026-10-06","2026-10-07","2026-10-08","2026-10-09","2026-10-10","2026-10-11"],"modelCallCount":[701,2299,1576,2083,1259,2091,1078,1225,1045,1124,1065,1761,641,681,1490,87,0,346,67,883,550,1081,21,416,203,622,929,342,5,1346,607],"tokensUsage":[70121069,284507537,202934668,231271730,140870524,328400649,176805554,123744376,115802209,119676966,120604441,289641618,128829319,107993983,218047892,7385362,0,55326530,18432457,146291343,59297381,182815397,478753,69025425,36542104,60371672,89260886,30837869,49208,188680597,82113671],"totalUsage":{"totalModelCallCount":27624,"totalTokensUsage":3686161190,"modelSummaryList":[{"modelName":"GLM-5.3","totalTokens":1438489431,"sortOrder":1},{"modelName":"GLM-5.3-Flash","totalTokens":2247671759,"sortOrder":2}]},"modelDataList":[{"modelName":"GLM-5.3","sortOrder":1,"tokensUsage":[13781709,20930449,92592314,40296896,40887220,45336952,42167577,95752655,43290960,54003322,51717845,100655678,98735670,64292753,145137089,0,0,0,0,55659745,36361232,138745602,11739,19551974,9341969,35798197,75223510,25654642,0,47493704,45068028],"totalTokens":1438489431},{"modelName":"GLM-5.3-Flash","sortOrder":2,"tokensUsage":[56339360,263577088,110342354,190974834,99983304,283063697,134637977,27991721,72511249,65673644,68886596,188985940,30093649,43701230,72910803,7385362,0,55326530,18432457,90631598,22936149,44069795,467014,49473451,27200135,24573475,14037376,5183227,49208,141186893,37045643],"totalTokens":2247671759}],"modelSummaryList":[{"modelName":"GLM-5.3","totalTokens":1438489431,"sortOrder":1},{"modelName":"GLM-5.3-Flash","totalTokens":2247671759,"sortOrder":2}],"granularity":"daily"},"success":true}"#;

    #[test]
    fn the_live_reply_decodes_with_date_string_buckets() {
        let usage = decode_model_usage(LIVE_MODEL_USAGE, 5_000).expect("decodes");
        assert_eq!(usage.daily_usage_buckets.len(), 31);
        assert_eq!(usage.daily_usage_buckets[0].start_date, "2026-09-11");
        assert_eq!(usage.daily_usage_buckets[0].tokens, Some(70_121_069));
        assert_eq!(usage.daily_usage_buckets[30].start_date, "2026-10-11");
        assert_eq!(usage.daily_usage_buckets[30].tokens, Some(82_113_671));

        assert_eq!(usage.summary.total_tokens, Some(3_686_161_190));
        assert_eq!(usage.summary.total_requests, Some(27_624));
        assert_eq!(usage.summary.peak_daily_tokens, Some(328_400_649));
        // One inactive day (2026-09-27): 16 active days before it, 14 after.
        assert_eq!(usage.summary.current_streak_days, Some(14));
        assert_eq!(usage.summary.longest_streak_days, Some(16));
        assert_eq!(usage.window_days, Some(30));
        assert_eq!(usage.fetched_at, 5_000);
    }

    #[test]
    fn the_live_reply_carries_the_per_model_breakdown() {
        let usage = decode_model_usage(LIVE_MODEL_USAGE, 0).expect("decodes");
        assert_eq!(usage.models.len(), 2);
        assert_eq!(usage.models[0].id, "glm-5.3");
        assert_eq!(usage.models[0].display_name, "GLM-5.3");
        assert_eq!(usage.models[0].tokens, 1_438_489_431);
        assert_eq!(usage.models[1].id, "glm-5.3-flash");
        assert_eq!(usage.models[1].tokens, 2_247_671_759);
    }

    #[test]
    fn the_synthetic_fixture_also_decodes_its_model_summary() {
        let usage = decode_model_usage(MODEL_USAGE, 0).expect("decodes");
        assert_eq!(usage.models.len(), 1);
        assert_eq!(usage.models[0].id, "glm-4.6");
        assert_eq!(usage.models[0].tokens, 800);
    }

    #[test]
    fn a_reply_without_model_rows_decodes_to_no_models() {
        let payload = r#"{"code":200,"msg":"ok","success":true,"data":{
            "x_time": [1767225600], "tokensUsage": [700]}}"#;
        let usage = decode_model_usage(payload, 0).expect("decodes");
        assert!(usage.models.is_empty());
    }

    #[test]
    fn the_integer_stamp_variant_decodes_identically() {
        // The shape openusage pinned: unix-seconds stamps. Dates differ by
        // form, not meaning: 1_767_225_600 s is 2026-01-01 in UTC+8.
        let payload = r#"{"code":200,"msg":"ok","success":true,"data":{
            "x_time": [1767225600, 1767312000],
            "tokensUsage": [700, 500]
        }}"#;
        let usage = decode_model_usage(payload, 0).expect("decodes");
        assert_eq!(usage.daily_usage_buckets[0].start_date, "2026-01-01");
        assert_eq!(usage.daily_usage_buckets[1].start_date, "2026-01-02");
    }
}
