//! Provider-agnostic domain types shared by every module.
//!
//! These are the values that cross the IPC boundary, so they carry provenance
//! (`source`) and an update timestamp by construction. It is impossible to
//! build one of these without saying where the number came from and when — a
//! hard requirement in `AGENTS.md`.

use serde::{Deserialize, Serialize};

/// Which provider a snapshot describes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    Codex,
    Zai,
    Minimax,
    Kimi,
}

impl ProviderKind {
    /// The wire tag, asserted against serde's output in the tests below.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Zai => "zai",
            Self::Minimax => "minimax",
            Self::Kimi => "kimi",
        }
    }

    /// The short name a tab or label renders for this provider.
    pub const fn display_name(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Zai => "Z.AI",
            Self::Minimax => "MiniMax",
            Self::Kimi => "Kimi",
        }
    }

    /// The provenance string stamped on this provider's readings.
    pub const fn source(self) -> &'static str {
        match self {
            Self::Codex => SOURCE_APP_SERVER,
            Self::Zai => "z.ai coding plan",
            Self::Minimax => "minimax token plan",
            Self::Kimi => "kimi code plan",
        }
    }
}

/// How fresh a reading is, and where it came from.
///
/// `Stale` is a first-class state rather than something the UI infers from a
/// timestamp, and `Unavailable` carries a reason instead of an absent value so
/// "could not fetch" never renders as `0`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Freshness {
    /// Read from the provider during this call.
    Live,
    /// Served from the in-memory cache because the provider call has not
    /// returned yet (or failed) since the last successful read.
    Cached,
    /// The value is older than the staleness threshold.
    Stale,
    /// No reading is available at all; `reason` explains why.
    Unavailable,
}

/// A single usage window (Codex reports a 5-hour and a weekly window).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// Stable label derived from the window duration, e.g. `"5h"`, `"weekly"`.
    pub label: String,
    /// Percentage of the window already consumed, 0-100.
    pub used_percent: i32,
    /// Rolling window length in minutes, when the provider reports one.
    pub duration_mins: Option<i64>,
    /// Unix **seconds** at which the window resets, when reported.
    pub resets_at: Option<i64>,
    /// Percentage still available, precomputed so every surface — main window,
    /// widget, and the status line — renders the bar the same way and none of
    /// them can invert it.
    pub remaining_percent: i32,
}

impl UsageWindow {
    /// Builds a window, deriving `remaining_percent` so the two can never
    /// disagree.
    ///
    /// The bar renders *remaining*, not used. Codex's own status code carries an
    /// explicit warning about inverting this
    /// (`codex-rs/tui/src/status/rate_limits.rs`), because an inverted bar
    /// reads as the opposite of the truth.
    pub fn new(
        label: impl Into<String>,
        used_percent: i32,
        duration_mins: Option<i64>,
        resets_at: Option<i64>,
    ) -> Self {
        let used_percent = used_percent.clamp(0, 100);
        Self {
            label: label.into(),
            used_percent,
            duration_mins,
            resets_at,
            // The protocol rounds `usedPercent` to an integer, so `100` alone
            // does not prove a hard stop.
            remaining_percent: (100 - used_percent).clamp(0, 100),
        }
    }
}

/// Provider-reported account token activity, distinct from subscription
/// limits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    pub fetched_at: i64,
    pub summary: AccountUsageSummary,
    pub daily_usage_buckets: Vec<DailyUsageBucket>,
    /// How many days the reported window covers, when the provider reports a
    /// bounded span rather than the account's lifetime. `None` means the
    /// numbers are lifetime, so the UI may label them "lifetime"; a present
    /// value must be shown, so a window total never poses as lifetime.
    #[serde(default)]
    pub window_days: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageSummary {
    /// The headline token total for the covered window: the account lifetime
    /// for Codex, the reported span for windowed providers.
    pub total_tokens: Option<u64>,
    pub peak_daily_tokens: Option<u64>,
    pub longest_running_turn_sec: Option<u64>,
    pub current_streak_days: Option<u64>,
    pub longest_streak_days: Option<u64>,
    /// Model calls in the window, when the provider counts them.
    #[serde(default)]
    pub total_requests: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsageBucket {
    pub start_date: String,
    pub tokens: Option<u64>,
}

/// The account plan behind the numbers, kept coarse so plan churn does not
/// break decoding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanKind {
    Free,
    Go,
    Plus,
    Pro,
    ProLite,
    ProMax,
    /// The Z.AI coding plan's `lite` tier, distinct from OpenAI's `proLite`.
    Lite,
    /// The Z.AI coding plan's `max` tier.
    Max,
    Team,
    Business,
    Enterprise,
    Edu,
    Other,
    Unknown,
}

impl PlanKind {
    /// Maps the provider's wire string onto the coarse domain enum. Anything
    /// unrecognised degrades to `Unknown` rather than failing the decode.
    pub fn from_wire(value: &str) -> Self {
        match value {
            "free" => Self::Free,
            "go" => Self::Go,
            "plus" => Self::Plus,
            "pro" => Self::Pro,
            "prolite" => Self::ProLite,
            "promax" => Self::ProMax,
            "lite" => Self::Lite,
            "max" => Self::Max,
            "team" => Self::Team,
            "business"
            | "self_serve_business_prolite"
            | "self_serve_business_usage_based"
            | "ent26"
            | "enterprise_cbp_automation"
            | "enterprise_cbp_usage_based" => Self::Business,
            "enterprise" => Self::Enterprise,
            "edu" | "edu_plus" | "edu_pro" => Self::Edu,
            _ => Self::Unknown,
        }
    }
}

/// Whether the account may currently make ordinary requests.
///
/// Tri-state on purpose. `Unknown` must never render as healthy: the provider
/// documents that a null means "unavailable", and that a client must not infer
/// recovery from percentages or reset times.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UsagePermission {
    Allowed,
    Blocked,
    /// The provider did not tell us. Not the same as `Allowed`.
    Unknown,
}

/// A complete reading for one provider.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub provider: ProviderKind,
    pub freshness: Freshness,
    /// Epoch **milliseconds**. `None` only for `Unavailable`.
    pub fetched_at: Option<i64>,
    /// Human-readable origin, e.g. `"codex app-server"`.
    pub source: String,
    /// Why no value is available. `Some` only for `Unavailable`.
    pub reason: Option<String>,
    pub plan: Option<PlanKind>,
    pub permission: UsagePermission,
    /// Every window the provider reported, already labelled.
    pub windows: Vec<UsageWindow>,
    /// The 5-hour window, when present. The scheduler keys off this.
    pub five_hour: Option<UsageWindow>,
    /// The weekly window, when present.
    pub weekly: Option<UsageWindow>,
}

impl UsageSnapshot {
    /// The "nothing to show" snapshot. Always carries a reason so the UI can
    /// render an explicit unavailable state rather than an empty number.
    pub fn unavailable(provider: ProviderKind, reason: impl Into<String>) -> Self {
        Self {
            provider,
            freshness: Freshness::Unavailable,
            fetched_at: None,
            source: provider.source().to_string(),
            reason: Some(reason.into()),
            plan: None,
            permission: UsagePermission::Unknown,
            windows: Vec::new(),
            five_hour: None,
            weekly: None,
        }
    }
}

/// Canonical origin string for provider readings.
pub const SOURCE_APP_SERVER: &str = "codex app-server";

/// Where a subscription's credential reached this machine.
///
/// Read from OpenCode's own stores; this app never holds or writes a
/// credential itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialOrigin {
    /// A credential row in OpenCode's store.
    Stored,
    /// A live environment variable named by the provider catalog.
    Environment,
    /// OpenCode reports the provider as available without a stored credential;
    /// the exact origin was not determined.
    Unknown,
}

/// A coding subscription the user connected through OpenCode.
///
/// Describes what OpenCode itself reports — this app adds no credential
/// handling of its own. `integration` is `None` for a connected plan this build
/// cannot read usage for, which the UI must render as "no reading" rather than
/// fabricating a number.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingSubscription {
    /// The models.dev catalog id, e.g. `"zai-coding-plan"`.
    pub provider_id: String,
    /// The catalog's full display name, e.g. `"Z.AI Coding Plan"`.
    pub name: String,
    /// The short label a tab renders, e.g. `"Z.AI"`.
    pub label: String,
    /// The usage-reading integration for this plan, when one exists.
    pub integration: Option<ProviderKind>,
    pub credential: CredentialOrigin,
    /// The plan's API base URL, when the catalog carries one.
    pub api_base: Option<String>,
}

/// Classifies a window by duration, mirroring the fuzzy buckets Codex's own
/// status line uses (`codex-rs/tui/src/chatwidget/rate_limits.rs`).
///
/// A ±5% tolerance is required: the provider reports 300 minutes for the 5-hour
/// window, but rounding in the backend means an exact equality test is wrong.
pub fn window_label(duration_mins: Option<i64>, is_secondary: bool) -> String {
    const MINUTES_PER_HOUR: i64 = 60;
    const MINUTES_PER_DAY: i64 = 24 * MINUTES_PER_HOUR;
    const MINUTES_PER_WEEK: i64 = 7 * MINUTES_PER_DAY;
    const MINUTES_PER_MONTH: i64 = 30 * MINUTES_PER_DAY;
    const MINUTES_PER_YEAR: i64 = 365 * MINUTES_PER_DAY;

    let Some(minutes) = duration_mins.map(|m| m.max(0)) else {
        return fallback_label(is_secondary).to_string();
    };

    if is_approximate(minutes, 5 * MINUTES_PER_HOUR) {
        "5h".to_string()
    } else if is_approximate(minutes, MINUTES_PER_DAY) {
        "daily".to_string()
    } else if is_approximate(minutes, MINUTES_PER_WEEK) {
        "weekly".to_string()
    } else if is_approximate(minutes, MINUTES_PER_MONTH) {
        "monthly".to_string()
    } else if is_approximate(minutes, MINUTES_PER_YEAR) {
        "annual".to_string()
    } else {
        fallback_label(is_secondary).to_string()
    }
}

fn fallback_label(is_secondary: bool) -> &'static str {
    if is_secondary {
        "secondary usage"
    } else {
        "usage"
    }
}

fn is_approximate(minutes: i64, expected: i64) -> bool {
    let minutes = minutes as f64;
    let expected = expected as f64;
    (minutes - expected).abs() <= expected * 0.05
}

/// Rolling windows after which a cached snapshot is reported as stale.
///
/// Matches the threshold Codex's own status card uses, so the app and the CLI
/// agree on when a reading has gone cold.
pub const STALE_THRESHOLD_MINS: i64 = 15;

/// Whether a snapshot taken at `fetched_at_ms` is still fresh at `now_ms`.
///
/// `Unavailable` never "goes stale" — it is already in its terminal state.
pub fn freshness_for(now_ms: i64, fetched_at_ms: Option<i64>) -> Freshness {
    let Some(fetched_at) = fetched_at_ms else {
        return Freshness::Unavailable;
    };
    let age_mins = (now_ms - fetched_at) / 60_000;
    if age_mins > STALE_THRESHOLD_MINS {
        Freshness::Stale
    } else {
        Freshness::Live
    }
}

// ---------------------------------------------------------------------------
// Kickoff model catalogs
// ---------------------------------------------------------------------------

/// One model a subscription's scheduled kickoff may use.
///
/// Lives in `shared/` because two modules need it: the kickoff surface shapes
/// it for the renderer's picker, and the provider pipeline resolves a `None`
/// selection to the cheapest entry. Serialized but not deserialized: the
/// catalog is authored in this file, never read back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KickoffModelInfo {
    pub id: &'static str,
    pub label: &'static str,
    /// The cheapest tier for plan quota — the default selection.
    pub cheapest: bool,
}

/// The model catalog for one provider, cheapest flagged.
///
/// Drawn from the vendors' own plan documentation (see
/// `.agents/tasks/research/kickoff-mechanisms.md`). Slugs are version-gated on
/// the vendor side, so a rejected model surfaces the provider's own error in
/// the attempt's detail rather than being filtered here.
pub fn models_for(kind: ProviderKind) -> &'static [KickoffModelInfo] {
    const CODEX: &[KickoffModelInfo] = &[
        KickoffModelInfo {
            id: "gpt-6.1-sol",
            label: "GPT-6.1 Sol",
            cheapest: false,
        },
        KickoffModelInfo {
            id: "gpt-6-luna",
            label: "GPT-6 Luna",
            cheapest: true,
        },
        KickoffModelInfo {
            id: "gpt-5.6-luna",
            label: "GPT-5.6 Luna",
            cheapest: false,
        },
    ];
    const ZAI: &[KickoffModelInfo] = &[
        KickoffModelInfo {
            id: "glm-5.3",
            label: "GLM-5.3",
            cheapest: false,
        },
        KickoffModelInfo {
            id: "glm-5.3-flash",
            label: "GLM-5.3 Flash",
            cheapest: true,
        },
    ];
    const MINIMAX: &[KickoffModelInfo] = &[
        KickoffModelInfo {
            id: "MiniMax-M3",
            label: "MiniMax M3",
            cheapest: false,
        },
        KickoffModelInfo {
            id: "MiniMax-M2",
            label: "MiniMax M2",
            cheapest: true,
        },
        KickoffModelInfo {
            id: "MiniMax-M2.5",
            label: "MiniMax M2.5",
            cheapest: false,
        },
    ];
    const KIMI: &[KickoffModelInfo] = &[
        KickoffModelInfo {
            id: "k3-256k",
            label: "K3 256K",
            cheapest: true,
        },
        KickoffModelInfo {
            id: "kimi-for-coding",
            label: "Kimi for Coding",
            cheapest: false,
        },
        KickoffModelInfo {
            id: "k3",
            label: "K3 (1M)",
            cheapest: false,
        },
        KickoffModelInfo {
            id: "kimi-for-coding-highspeed",
            label: "HighSpeed (3× quota)",
            cheapest: false,
        },
    ];

    match kind {
        ProviderKind::Codex => CODEX,
        ProviderKind::Zai => ZAI,
        ProviderKind::Minimax => MINIMAX,
        ProviderKind::Kimi => KIMI,
    }
}

/// The cheapest model for a provider — the default kickoff selection.
pub fn cheapest_model(kind: ProviderKind) -> &'static str {
    models_for(kind)
        .iter()
        .find(|model| model.cheapest)
        .map(|model| model.id)
        .unwrap_or_default()
}

/// Whether `model_id` names a model this build offers for `kind`.
pub fn is_known_model(kind: ProviderKind, model_id: &str) -> bool {
    models_for(kind).iter().any(|model| model.id == model_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_the_five_hour_window() {
        assert_eq!(window_label(Some(300), false), "5h");
    }

    #[test]
    fn labels_the_weekly_window() {
        assert_eq!(window_label(Some(10_080), true), "weekly");
    }

    #[test]
    fn tolerates_backend_rounding_around_five_hours() {
        // The backend rounds; 294 and 306 are both still a 5-hour window.
        assert_eq!(window_label(Some(294), false), "5h");
        assert_eq!(window_label(Some(306), false), "5h");
    }

    #[test]
    fn does_not_mistake_a_daily_window_for_five_hour() {
        assert_eq!(window_label(Some(1_440), false), "daily");
    }

    #[test]
    fn falls_back_when_duration_is_unknown() {
        assert_eq!(window_label(None, false), "usage");
        assert_eq!(window_label(None, true), "secondary usage");
    }

    #[test]
    fn falls_back_for_an_unknown_duration() {
        assert_eq!(window_label(Some(37), false), "usage");
    }

    #[test]
    fn remaining_is_the_inverse_of_used() {
        let window = UsageWindow::new("5h", 12, Some(300), None);
        assert_eq!(window.used_percent, 12);
        assert_eq!(window.remaining_percent, 88);
    }

    #[test]
    fn remaining_never_goes_negative_on_a_rounded_hundred() {
        let window = UsageWindow::new("5h", 100, Some(300), None);
        assert_eq!(window.remaining_percent, 0);
    }

    #[test]
    fn an_out_of_range_percentage_is_clamped_on_construction() {
        // A backend reporting 140 must not produce a negative remaining value
        // and an inverted bar.
        let window = UsageWindow::new("5h", 140, Some(300), None);
        assert_eq!(window.used_percent, 100);
        assert_eq!(window.remaining_percent, 0);
    }

    #[test]
    fn used_and_remaining_cannot_disagree() {
        for used in [0, 1, 50, 99, 100] {
            let window = UsageWindow::new("5h", used, None, None);
            assert_eq!(window.remaining_percent, 100 - used);
        }
    }

    #[test]
    fn maps_known_plans() {
        assert_eq!(PlanKind::from_wire("pro"), PlanKind::Pro);
        assert_eq!(PlanKind::from_wire("team"), PlanKind::Team);
        assert_eq!(PlanKind::from_wire("lite"), PlanKind::Lite);
        assert_eq!(PlanKind::from_wire("max"), PlanKind::Max);
    }

    #[test]
    fn degrades_unknown_plans_instead_of_failing() {
        assert_eq!(PlanKind::from_wire("something_new"), PlanKind::Unknown);
    }

    #[test]
    fn fresh_reading_is_live() {
        assert_eq!(freshness_for(1_000_000, Some(999_000)), Freshness::Live);
    }

    #[test]
    fn old_reading_is_stale() {
        let now = 20 * 60_000;
        assert_eq!(freshness_for(now, Some(0)), Freshness::Stale);
    }

    #[test]
    fn missing_timestamp_is_unavailable_never_live() {
        // A null timestamp must not be read as a perfectly fresh value.
        assert_eq!(freshness_for(20 * 60_000, None), Freshness::Unavailable);
    }

    #[test]
    fn provider_tag_matches_the_serde_wire_value() {
        let json = serde_json::to_value(ProviderKind::Codex).expect("serializes");
        assert_eq!(json, serde_json::json!("codex"));
        assert_eq!(ProviderKind::Codex.as_str(), "codex");
    }

    #[test]
    fn every_provider_tag_matches_the_serde_wire_value() {
        for kind in [ProviderKind::Zai, ProviderKind::Minimax, ProviderKind::Kimi] {
            assert_eq!(
                serde_json::to_value(kind).expect("serializes"),
                serde_json::json!(kind.as_str()),
                "{} disagreed with serde",
                kind.as_str()
            );
        }
    }

    #[test]
    fn an_unavailable_snapshot_names_its_own_source() {
        // A provider that never spoke must not claim it read a different
        // provider's transport.
        let snapshot = UsageSnapshot::unavailable(ProviderKind::Zai, "not connected");
        assert_eq!(snapshot.source, ProviderKind::Zai.source());
        assert_ne!(snapshot.source, ProviderKind::Codex.source());
    }

    #[test]
    fn subscription_round_trips_camel_cased() {
        let subscription = CodingSubscription {
            provider_id: "zai-coding-plan".to_string(),
            name: "Z.AI Coding Plan".to_string(),
            label: "Z.AI".to_string(),
            integration: Some(ProviderKind::Zai),
            credential: CredentialOrigin::Stored,
            api_base: Some("https://api.z.ai/api/coding/paas/v4".to_string()),
        };
        let json = serde_json::to_value(&subscription).expect("serializes");
        assert_eq!(json["providerId"], "zai-coding-plan");
        assert_eq!(json["credential"], "stored");
        assert_eq!(json["integration"], "zai");
    }

    #[test]
    fn freshness_and_permission_tags_match_their_wire_values() {
        // The client switches on these strings, so serde and the enum must
        // agree for every variant.
        assert_eq!(
            serde_json::to_value(Freshness::Unavailable).expect("serializes"),
            serde_json::json!("unavailable")
        );
        assert_eq!(
            serde_json::to_value(UsagePermission::Unknown).expect("serializes"),
            serde_json::json!("unknown")
        );
    }

    #[test]
    fn plan_tags_are_camel_cased_on_the_wire() {
        assert_eq!(
            serde_json::to_value(PlanKind::ProLite).expect("serializes"),
            serde_json::json!("proLite")
        );
        assert_eq!(
            serde_json::to_value(PlanKind::ProMax).expect("serializes"),
            serde_json::json!("proMax")
        );
    }

    #[test]
    fn unavailable_snapshot_carries_a_reason() {
        let snapshot = UsageSnapshot::unavailable(ProviderKind::Codex, "codex not found");
        assert_eq!(snapshot.freshness, Freshness::Unavailable);
        assert_eq!(snapshot.reason.as_deref(), Some("codex not found"));
        assert!(snapshot.five_hour.is_none());
    }

    #[test]
    fn every_provider_has_exactly_one_cheapest_model() {
        for kind in [
            ProviderKind::Codex,
            ProviderKind::Zai,
            ProviderKind::Minimax,
            ProviderKind::Kimi,
        ] {
            let cheapest = models_for(kind).iter().filter(|m| m.cheapest).count();
            assert_eq!(cheapest, 1, "{} must have one cheapest", kind.as_str());
            assert!(!cheapest_model(kind).is_empty());
        }
    }

    #[test]
    fn known_models_validate_and_others_do_not() {
        assert!(is_known_model(ProviderKind::Kimi, "k3-256k"));
        assert!(!is_known_model(ProviderKind::Kimi, "kimi-k2-turbo-preview"));
    }

    #[test]
    fn the_model_catalog_serializes_camel_cased_for_the_picker() {
        let json =
            serde_json::to_value(models_for(ProviderKind::Zai)[0].clone()).expect("serializes");
        assert_eq!(json["id"], "glm-5.3");
        assert_eq!(json["cheapest"], false);
    }
}
