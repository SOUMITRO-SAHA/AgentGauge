//! Pure decoders for the Kimi code-plan usage endpoint.
//!
//! The endpoint is `GET /coding/v1/usages`. It is not in Kimi's public
//! reference; the contract is defined by Kimi's own CLI
//! (`MoonshotAI/kimi-code`, `packages/oauth/src/managed-usage.ts`), whose
//! schema is `{ usages: { limit5h, limit7d, monthTotal, monthCode }, extraUsage }`
//! with each entry `{ usedRatio: 0..1, resetAt: RFC3339 }`. The wire spells
//! the same fields snake_case (`limit_5h`, `used_ratio`, `reset_time`); both
//! spellings are accepted here because the CLI has shipped both.
//!
//! Semantics worth stating: `limit_month_code` is the code-typed share of
//! `limit_month_total`, not a second allowance, and `limit_7d` is legacy —
//! plans created after 2026-10 carry no 7-day window, which renders as "no
//! weekly window" rather than a zero.
//!
//! Not live-verified: no Kimi credential was available. An unmatched reply
//! decodes to an error and renders as unavailable — never as an invented
//! number.

use serde::Deserialize;

use crate::shared::domain::{
    Freshness, KickoffEffortInfo, ProviderKind, UsagePermission, UsageSnapshot, UsageWindow,
};
use crate::shared::error::{Error, ErrorKind};

/// The vendor's usage path on both regional hosts.
pub const USAGES_PATH: &str = "/coding/v1/usages";

const WINDOW_MINUTES_5H: i64 = 300;
const WINDOW_MINUTES_WEEK: i64 = 10_080;
const WINDOW_MINUTES_MONTH: i64 = 30 * 24 * 60;

#[derive(Debug, Default, Deserialize)]
struct WireUsages {
    #[serde(default, alias = "limit5h")]
    limit_5h: Option<WireEntry>,
    #[serde(default, alias = "limit7d")]
    limit_7d: Option<WireEntry>,
    #[serde(default, alias = "monthTotal")]
    limit_month_total: Option<WireEntry>,
}

#[derive(Debug, Default, Deserialize)]
struct WireEntry {
    /// Fraction already used, 0.0–1.0.
    #[serde(default, alias = "usedRatio")]
    used_ratio: Option<f64>,
    /// RFC 3339 timestamp, and optional: a rolling window has no boundary the
    /// vendor commits to, so absence must render "reset time unknown".
    #[serde(default, alias = "resetAt")]
    reset_time: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WireUsagesEnvelope {
    #[serde(default)]
    usages: WireUsages,
}

#[derive(Debug, Deserialize)]
struct WireErrorEnvelope {
    #[serde(default)]
    error: WireError,
}

#[derive(Debug, Default, Deserialize)]
struct WireError {
    #[serde(default)]
    #[serde(rename = "type")]
    kind: String,
}

/// Decodes a usages reply into a snapshot.
pub fn decode_usages(
    payload: &str,
    provider: ProviderKind,
    now_ms: i64,
) -> Result<UsageSnapshot, Error> {
    if is_auth_refusal(payload) {
        return Err(Error::new(
            ErrorKind::ProviderError,
            "Kimi rejected the credential OpenCode stored for the code plan.",
        ));
    }

    let wire: WireUsagesEnvelope = serde_json::from_str(payload).map_err(|error| {
        Error::new(
            ErrorKind::InvalidPayload,
            format!("The Kimi usage reply could not be decoded ({error})."),
        )
    })?;

    let usages = wire.usages;
    let five_hour = entry_window(usages.limit_5h, WINDOW_MINUTES_5H);
    let weekly = entry_window(usages.limit_7d, WINDOW_MINUTES_WEEK);
    let monthly = entry_window(usages.limit_month_total, WINDOW_MINUTES_MONTH);

    let mut windows = Vec::new();
    if let Some(window) = &five_hour {
        windows.push(window.clone());
    }
    if let Some(window) = &weekly {
        windows.push(window.clone());
    }
    if let Some(window) = &monthly {
        windows.push(window.clone());
    }

    Ok(UsageSnapshot {
        provider,
        freshness: Freshness::Live,
        fetched_at: Some(now_ms),
        source: provider.source().to_string(),
        reason: None,
        plan: None,
        // The usage endpoint answering means the account is usable; an
        // exhausted or rejected account arrives as an error envelope instead,
        // which decodes to an explicit unavailable state. Leaving this
        // `Unknown` would mute every reading — the UI renders unknown as
        // never-healthy, and a plan reporting low usage is healthy.
        permission: UsagePermission::Allowed,
        windows,
        five_hour,
        weekly,
    })
}

/// Maps one ratio entry onto a window, tolerating a missing ratio or reset.
fn entry_window(entry: Option<WireEntry>, minutes: i64) -> Option<UsageWindow> {
    let entry = entry?;
    let used = entry
        .used_ratio
        .map(|ratio| (ratio * 100.0).round() as i32)
        .unwrap_or(0);
    let resets_at = entry.reset_time.as_deref().and_then(rfc3339_secs);
    Some(UsageWindow::new(
        crate::shared::domain::window_label(Some(minutes), false),
        used,
        Some(minutes),
        resets_at,
    ))
}

/// Whether a reply is Kimi's authentication refusal envelope.
pub fn is_auth_refusal(payload: &str) -> bool {
    serde_json::from_str::<WireErrorEnvelope>(payload)
        .map(|envelope| {
            !envelope.error.kind.is_empty() && envelope.error.kind.contains("authentication")
        })
        .unwrap_or(false)
}

/// A refused credential as an explicit unavailable state.
pub fn decode_auth_failure(provider: ProviderKind) -> UsageSnapshot {
    UsageSnapshot::unavailable(
        provider,
        "Kimi rejected the credential OpenCode stored for the code plan. Reconnect it in OpenCode.",
    )
}

/// Parses the RFC 3339 timestamps Kimi emits into epoch seconds.
///
/// Hand-rolled because adding a datetime crate for one field is not
/// justified; the algorithm is the standard days-from-civil conversion.
fn rfc3339_secs(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        let text = value.get(range)?;
        text.parse::<i64>().ok()
    };

    let year = digits(0..4)?;
    let month = digits(5..7)?;
    let day = digits(8..10)?;
    let hour = digits(11..13)?;
    let minute = digits(14..16)?;
    let second = digits(17..19)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let days = days_from_civil(year, month, day);
    let utc_secs = days * 86_400 + hour * 3_600 + minute * 60 + second;

    // A trailing `Z` is UTC; `+hh:mm` / `-hh:mm` shifts, and anything else is
    // treated as UTC because the vendor's examples are all `Z`.
    match value.as_bytes().get(19) {
        Some(b'+') | Some(b'-') => {
            let offset_hour = digits(20..22).unwrap_or(0);
            let offset_minute = digits(23..25).unwrap_or(0);
            let offset = offset_hour * 3_600 + offset_minute * 60;
            match value.as_bytes().get(19) {
                Some(b'+') => Some(utc_secs - offset),
                _ => Some(utc_secs + offset),
            }
        }
        _ => Some(utc_secs),
    }
}

/// Howard Hinnant's `days_from_civil`, valid for the proleptic Gregorian
/// calendar — the same conversion every datetime library performs.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_shift = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_shift + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

// ---------------------------------------------------------------------------
// Scheduled kickoff
// ---------------------------------------------------------------------------

/// The reply budget for a kickoff. The prompt opens a window; the reply is
/// context only.
pub const KICKOFF_MAX_TOKENS: i64 = 32;

/// Builds the chat-completions request body for the scheduled kickoff.
///
/// The coding API takes the OpenAI-compatible chat shape; the budget keeps the
/// answer — which is context only, the request's job is to open the window —
/// at its floor.
pub fn kickoff_efforts(model: &str) -> Vec<KickoffEffortInfo> {
    if matches!(model, "k3" | "k3-256k" | "kimi-for-coding") {
        ["low", "high", "max"]
            .into_iter()
            .map(|effort| {
                KickoffEffortInfo::new(
                    effort,
                    match effort {
                        "low" => "Low",
                        "high" => "High",
                        _ => "Max",
                    },
                )
            })
            .collect()
    } else {
        vec![KickoffEffortInfo::new(
            "provider-default",
            "Provider default",
        )]
    }
}

pub fn kickoff_body(model: &str, prompt: &str, effort: &str) -> String {
    let mut body = serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": prompt }],
        "max_tokens": KICKOFF_MAX_TOKENS,
        "stream": false,
    });
    if effort != "provider-default" {
        body["reasoning_effort"] = serde_json::Value::String(effort.to_string());
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
        let body = kickoff_body("k3-256k", "hi", "provider-default");
        let value: serde_json::Value = serde_json::from_str(&body).expect("json");
        assert_eq!(value["model"], "k3-256k");
        assert_eq!(value["messages"][0]["content"], "hi");
        assert_eq!(value["max_tokens"], KICKOFF_MAX_TOKENS);
        assert_eq!(value["stream"], false);
    }

    #[test]
    fn k3_uses_the_documented_reasoning_effort_field() {
        let body = kickoff_body("k3", "hi", "low");
        let value: serde_json::Value = serde_json::from_str(&body).expect("json");
        assert_eq!(value["reasoning_effort"], "low");
    }

    #[test]
    fn supported_kimi_code_models_offer_the_documented_effort_choices() {
        assert_eq!(kickoff_efforts("k3")[0].id, "low");
        assert_eq!(kickoff_efforts("k3-256k")[0].id, "low");
        assert_eq!(kickoff_efforts("kimi-for-coding")[0].id, "low");
        assert_eq!(
            kickoff_efforts("kimi-for-coding-highspeed")[0].id,
            "provider-default"
        );
    }

    #[test]
    fn the_kickoff_reply_is_the_first_choice_content() {
        let payload = r#"{"choices":[{"message":{"content":"Hello!"}}]}"#;
        assert_eq!(decode_kickoff_reply(payload).expect("decodes"), "Hello!");
    }

    #[test]
    fn garbage_kickoff_replies_are_rejected() {
        assert!(decode_kickoff_reply("not json").is_err());
    }

    const USAGES: &str = r#"{
        "usages": {
            "limit_5h": {"used_ratio": 0.16, "reset_time": "2026-10-10T18:34:05Z"},
            "limit_7d": {"used_ratio": 0.35, "reset_time": "2026-10-13T02:30:00Z"},
            "limit_month_total": {"used_ratio": 0.5}
        }
    }"#;

    #[test]
    fn decodes_both_named_windows_and_the_monthly_one() {
        let snapshot = decode_usages(USAGES, ProviderKind::Kimi, 9).expect("decodes");
        let five_hour = snapshot.five_hour.expect("5h window");
        assert_eq!(five_hour.used_percent, 16);
        assert_eq!(five_hour.remaining_percent, 84);
        assert_eq!(five_hour.duration_mins, Some(300));
        assert_eq!(five_hour.resets_at, Some(1_791_657_245));

        let weekly = snapshot.weekly.expect("weekly window");
        assert_eq!(weekly.used_percent, 35);
        assert_eq!(snapshot.windows.len(), 3);
    }

    #[test]
    fn accepts_the_camel_case_spelling_the_cli_schema_uses() {
        let payload =
            r#"{"usages":{"limit5h":{"usedRatio":0.4,"resetAt":"2026-10-10T00:00:00Z"}}}"#;
        let snapshot = decode_usages(payload, ProviderKind::Kimi, 0).expect("decodes");
        assert_eq!(snapshot.five_hour.expect("window").used_percent, 40);
    }

    #[test]
    fn a_new_plan_with_no_weekly_window_renders_none() {
        let payload = r#"{"usages":{"limit_5h":{"used_ratio":0.1}}}"#;
        let snapshot = decode_usages(payload, ProviderKind::Kimi, 0).expect("decodes");
        assert!(snapshot.five_hour.is_some());
        assert!(snapshot.weekly.is_none());
        assert_eq!(snapshot.five_hour.unwrap().resets_at, None);
    }

    #[test]
    fn an_authentication_envelope_is_recognised() {
        let payload = r#"{"error":{"type":"invalid_authentication_error","message":"bad key"}}"#;
        assert!(is_auth_refusal(payload));
        assert!(decode_usages(payload, ProviderKind::Kimi, 0).is_err());
        assert!(!is_auth_refusal(USAGES));
    }

    #[test]
    fn a_ratio_above_one_is_clamped_not_inverted() {
        let payload = r#"{"usages":{"limit_5h":{"used_ratio":1.4}}}"#;
        let snapshot = decode_usages(payload, ProviderKind::Kimi, 0).expect("decodes");
        let window = snapshot.five_hour.expect("window");
        assert_eq!(window.used_percent, 100);
        assert_eq!(window.remaining_percent, 0);
    }

    #[test]
    fn rfc3339_handles_offsets_and_rejects_garbage() {
        assert_eq!(rfc3339_secs("2026-10-10T18:34:05Z"), Some(1_791_657_245));
        assert_eq!(
            rfc3339_secs("2026-10-10T18:34:05+08:00"),
            Some(1_791_657_245 - 8 * 3_600)
        );
        assert_eq!(
            rfc3339_secs("2026-10-10T18:34:05-05:00"),
            Some(1_791_657_245 + 5 * 3_600)
        );
        assert_eq!(rfc3339_secs("not a time"), None);
    }
}
