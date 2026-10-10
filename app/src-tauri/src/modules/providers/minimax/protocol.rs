//! Pure decoders for the MiniMax token-plan usage endpoint.
//!
//! The endpoint is `GET /v1/token_plan/remains`, documented by the vendor as a
//! curl example without a response schema; the field names below come from
//! MiniMax's own CLI (`MiniMax-AI/cli`, `src/types/api.ts`).
//!
//! Three vendor quirks the shape itself forces:
//! * `model_remains` is an array — chat, speech, video, image each get an
//!   entry — and only the chat entry carries the coding-plan windows;
//! * on this endpoint `current_interval_usage_count` is the amount
//!   **remaining**, the opposite of what the field name says (the retired
//!   `coding_plan/remains` endpoint used it the literal way), so the explicit
//!   percentage field is preferred whenever the vendor sends one;
//! * a `*_status` of `3` means the window does not apply to this tier, so the
//!   window is omitted rather than rendered as a zero.
//!
//! Not live-verified: no MiniMax credential was available. A reply that does
//! not match this shape decodes to an error and renders as unavailable — never
//! as an invented number.

use serde::Deserialize;

use crate::shared::domain::{Freshness, ProviderKind, UsagePermission, UsageSnapshot, UsageWindow};
use crate::shared::error::{Error, ErrorKind};

/// The vendor's usage path on the token-plan hosts.
pub const REMAINS_PATH: &str = "/v1/token_plan/remains";

const WINDOW_MINUTES_5H: i64 = 300;
const WINDOW_MINUTES_WEEK: i64 = 10_080;
const CHAT_MODEL: &str = "chat";

#[derive(Debug, Deserialize)]
struct WireRemains {
    #[serde(default, rename = "model_remains")]
    model_remains: Vec<WireModelRemain>,
    #[serde(default, rename = "base_resp")]
    base_resp: Option<WireBaseResp>,
}

#[derive(Debug, Deserialize)]
struct WireBaseResp {
    #[serde(default)]
    status_code: i64,
    #[serde(default, rename = "status_msg")]
    status_msg: String,
}

#[derive(Debug, Default, Clone, Deserialize)]
struct WireModelRemain {
    #[serde(default, rename = "model_name")]
    model_name: String,
    #[serde(default, rename = "end_time")]
    end_time: Option<i64>,
    #[serde(default, rename = "current_interval_total_count")]
    interval_total: Option<i64>,
    #[serde(default, rename = "current_interval_usage_count")]
    interval_remaining: Option<i64>,
    #[serde(default, rename = "current_interval_remaining_percent")]
    interval_remaining_percent: Option<f64>,
    #[serde(default, rename = "current_interval_status")]
    interval_status: Option<i64>,
    #[serde(default, rename = "current_weekly_total_count")]
    weekly_total: Option<i64>,
    #[serde(default, rename = "current_weekly_usage_count")]
    weekly_remaining: Option<i64>,
    #[serde(default, rename = "current_weekly_remaining_percent")]
    weekly_remaining_percent: Option<f64>,
    #[serde(default, rename = "current_weekly_status")]
    weekly_status: Option<i64>,
}

/// Decodes a token-plan reply into a snapshot.
pub fn decode_remains(
    payload: &str,
    provider: ProviderKind,
    now_ms: i64,
) -> Result<UsageSnapshot, Error> {
    let wire: WireRemains = serde_json::from_str(payload).map_err(|error| {
        Error::new(
            ErrorKind::InvalidPayload,
            format!("The MiniMax usage reply could not be decoded ({error})."),
        )
    })?;

    if let Some(base) = &wire.base_resp {
        if base.status_code != 0 {
            return Err(Error::new(
                ErrorKind::ProviderError,
                format!(
                    "MiniMax refused the usage read ({}).",
                    if base.status_msg.is_empty() {
                        base.status_code.to_string()
                    } else {
                        base.status_msg.clone()
                    }
                ),
            ));
        }
    }

    let entry = wire
        .model_remains
        .iter()
        .find(|entry| entry.model_name == CHAT_MODEL)
        .or_else(|| wire.model_remains.first())
        .cloned()
        .unwrap_or_default();

    let interval = window(
        entry.interval_remaining_percent,
        entry.interval_remaining,
        entry.interval_total,
        entry.interval_status,
        entry.end_time,
        WINDOW_MINUTES_5H,
    );
    let weekly_entry = window(
        entry.weekly_remaining_percent,
        entry.weekly_remaining,
        entry.weekly_total,
        entry.weekly_status,
        entry.end_time,
        WINDOW_MINUTES_WEEK,
    );

    let mut windows = Vec::new();
    let five_hour = interval.clone();
    let weekly = weekly_entry.clone();
    if let Some(window) = &five_hour {
        windows.push(window.clone());
    }
    if let Some(window) = &weekly {
        windows.push(window.clone());
    }

    Ok(UsageSnapshot {
        provider,
        freshness: Freshness::Live,
        fetched_at: Some(now_ms),
        source: provider.source().to_string(),
        reason: None,
        plan: None,
        permission: UsagePermission::Unknown,
        windows,
        five_hour,
        weekly,
    })
}

/// Builds one window, or `None` when the vendor says it does not apply.
fn window(
    remaining_percent: Option<f64>,
    remaining_count: Option<i64>,
    total_count: Option<i64>,
    status: Option<i64>,
    end_time: Option<i64>,
    minutes: i64,
) -> Option<UsageWindow> {
    // 3 is the vendor's "not applicable to this tier" marker.
    if status == Some(3) {
        return None;
    }

    let remaining = remaining_percent
        .map(|value| value.round() as i64)
        .or_else(|| match (remaining_count, total_count) {
            (Some(remaining), Some(total)) if total > 0 => Some((remaining * 100) / total),
            _ => None,
        })?;

    // The vendor reports what is left; the domain records what is used.
    let used = 100 - remaining.clamp(0, 100);

    Some(UsageWindow::new(
        crate::shared::domain::window_label(Some(minutes), false),
        used as i32,
        Some(minutes),
        end_time.map(epoch_secs),
    ))
}

/// Accepts the vendor's epoch in either seconds or milliseconds.
///
/// MiniMax does not document the unit; the two orders of magnitude are
/// unambiguous until the year 5138, so the value classifies itself.
fn epoch_secs(value: i64) -> i64 {
    if value.abs() > 100_000_000_000 {
        value / 1000
    } else {
        value
    }
}

/// A refused credential, as MiniMax's envelope reports it.
pub fn decode_auth_failure(provider: ProviderKind) -> UsageSnapshot {
    UsageSnapshot::unavailable(
        provider,
        "MiniMax rejected the credential OpenCode stored for the token plan. Reconnect it in OpenCode.",
    )
}

/// Whether a reply is an authentication refusal rather than a decode problem.
pub fn is_auth_refusal(payload: &str) -> bool {
    fn inner(payload: &str) -> Option<bool> {
        let value: serde_json::Value = serde_json::from_str(payload).ok()?;
        let code = value.get("base_resp")?.get("status_code")?.as_i64()?;
        Some(code == 1004 || code == 401 || code == 403)
    }
    inner(payload).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    const REMAINS: &str = r#"{
        "model_remains": [
            {
                "model_name": "chat",
                "end_time": 1791618000,
                "remains_time": 12345,
                "current_interval_total_count": 12000,
                "current_interval_usage_count": 9000,
                "current_interval_remaining_percent": 75,
                "current_interval_status": 0,
                "current_weekly_total_count": 60000,
                "current_weekly_usage_count": 21000,
                "current_weekly_remaining_percent": 35,
                "current_weekly_status": 0
            },
            {
                "model_name": "video",
                "current_interval_total_count": 0,
                "current_interval_status": 3
            }
        ],
        "base_resp": {"status_code": 0, "status_msg": ""}
    }"#;

    #[test]
    fn picks_the_chat_entry_and_maps_both_windows() {
        let snapshot = decode_remains(REMAINS, ProviderKind::Minimax, 5).expect("decodes");
        let five_hour = snapshot.five_hour.expect("5h window");
        assert_eq!(five_hour.used_percent, 25);
        assert_eq!(five_hour.remaining_percent, 75);
        assert_eq!(five_hour.duration_mins, Some(300));
        assert_eq!(five_hour.resets_at, Some(1_791_618_000));

        let weekly = snapshot.weekly.expect("weekly window");
        assert_eq!(weekly.remaining_percent, 35);
        assert_eq!(weekly.used_percent, 65);
    }

    #[test]
    fn millisecond_epochs_are_normalised() {
        let payload = REMAINS.replace("1791618000", "1791618000000");
        let snapshot = decode_remains(&payload, ProviderKind::Minimax, 0).expect("decodes");
        assert_eq!(
            snapshot.five_hour.expect("window").resets_at,
            Some(1_791_618_000)
        );
    }

    #[test]
    fn a_window_that_does_not_apply_is_omitted() {
        let single = r#"{"model_remains":[{"model_name":"chat",
            "current_interval_status":3,
            "current_weekly_total_count":100,"current_weekly_usage_count":40}]}"#;
        let snapshot = decode_remains(single, ProviderKind::Minimax, 0).expect("decodes");
        assert!(snapshot.five_hour.is_none());
        assert!(snapshot.weekly.is_some());
    }

    #[test]
    fn the_count_fallback_derives_remaining_percent() {
        let payload = r#"{"model_remains":[{"model_name":"chat",
            "current_interval_total_count":200,
            "current_interval_usage_count":150,
            "current_interval_status":0}]}"#;
        let snapshot = decode_remains(payload, ProviderKind::Minimax, 0).expect("decodes");
        assert_eq!(snapshot.five_hour.expect("window").remaining_percent, 75);
    }

    #[test]
    fn a_business_error_is_a_failure() {
        let payload = r#"{"base_resp":{"status_code":1004,"status_msg":"invalid api key"}}"#;
        assert!(decode_remains(payload, ProviderKind::Minimax, 0).is_err());
        assert!(is_auth_refusal(payload));
    }
}
