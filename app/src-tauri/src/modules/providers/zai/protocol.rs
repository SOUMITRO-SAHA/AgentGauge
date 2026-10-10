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
    Freshness, PlanKind, ProviderKind, UsagePermission, UsageSnapshot, UsageWindow,
};
use crate::shared::error::{Error, ErrorKind};

/// The vendor's quota path, appended to the region host.
pub const QUOTA_PATH: &str = "/api/monitor/usage/quota/limit";

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
        permission: UsagePermission::Unknown,
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
