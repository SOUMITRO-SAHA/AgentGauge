//! Provider-agnostic domain types shared by every module.
//!
//! These are the values that cross the IPC boundary, so they carry provenance
//! (`source`) and an update timestamp by construction. It is impossible to
//! build one of these without saying where the number came from and when — a
//! hard requirement in `AGENTS.md`.

use serde::{Deserialize, Serialize};

/// Which provider a snapshot describes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    pub fetched_at: i64,
    pub summary: AccountUsageSummary,
    pub daily_usage_buckets: Vec<DailyUsageBucket>,
    /// Per-model breakdown, when the provider reports one. Empty is a real
    /// answer ("this provider totals only"), never a failed decode.
    #[serde(default)]
    pub models: Vec<ModelUsage>,
    /// What the app read from the user's own local harness logs, when the
    /// provider's local record was readable. `None` means the local record is
    /// absent — no Codex home, or a home with no rollouts — which is different
    /// from a scan that found nothing to price.
    #[serde(default)]
    pub local: Option<LocalUsage>,
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

/// One model's share of the reported usage, when the provider breaks its
/// totals down by model.
///
/// `id` is the normalised catalog slug (lowercase, price-list compatible) so
/// the renderer can join pricing without pattern-matching display names;
/// `display_name` keeps exactly what the provider reported.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub id: String,
    pub display_name: String,
    pub tokens: u64,
    /// Model calls attributed to this model, when the provider counts them.
    #[serde(default)]
    pub requests: Option<u64>,
}

/// One model's usage read from the user's own local logs, with the token split
/// a provider total can never carry.
///
/// `cost_usd` is `None` when the price list has no reference for this model, or
/// when it prices the model but omits a rate for a token class this model
/// actually used. It is never `Some(0.0)` for a model that could not be
/// priced: an unpriced model is a token count, not a free one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelUsage {
    /// The catalog slug when the model is known, otherwise the raw id the
    /// logs carried (Codex writes its own slugs, so this joins the price list
    /// directly).
    pub id: String,
    pub display_name: String,
    /// Prompt tokens, cache reads included.
    pub input: u64,
    pub cached_input: u64,
    pub cache_write: u64,
    /// Completion tokens, reasoning included.
    pub output: u64,
    /// The part of `output` spent reasoning.
    pub reasoning: u64,
    pub responses: u64,
    pub cost_usd: Option<f64>,
}

impl LocalModelUsage {
    pub fn total_tokens(&self) -> u64 {
        self.input + self.output
    }

    /// Prompt tokens that were not served from the cache.
    pub fn fresh_input(&self) -> u64 {
        self.input.saturating_sub(self.cached_input)
    }
}

/// One project's token totals, from the directory its turns ran in.
///
/// The name is the directory's **basename**, never the full path: an absolute
/// path leaks the account name and is unreadable in a ranked list. `cost_usd`
/// is `None` when the price list could not price every model the project used,
/// so the caller shows token counts instead of a `$0` that means "unknown".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProjectUsage {
    pub name: String,
    /// Prompt tokens, cache reads included.
    pub input: u64,
    /// Completion tokens, reasoning included.
    pub output: u64,
    pub responses: u64,
    #[serde(rename = "costUsd")]
    pub cost_usd: Option<f64>,
}

impl LocalProjectUsage {
    pub fn total_tokens(&self) -> u64 {
        self.input + self.output
    }
}

/// The project name for usage whose source recorded no working directory.
///
/// Shown as a visible row rather than dropped: the usage is real, and a
/// leaderboard whose total disagrees with the panel above it is the worse lie.
pub const NO_PROJECT: &str = "No project recorded";

/// The label for a working directory: its last path segment.
///
/// An absolute path would put the account name on screen and read badly in a
/// ranked list, so only the basename travels. Grouping still keys on the full
/// path, because two unrelated projects can share a basename and merging them
/// would be a dishonest row.
///
/// `None` when the directory is empty or is a filesystem root, which has no
/// name to show.
pub fn project_name(directory: &str) -> Option<&str> {
    let trimmed = directory.trim_end_matches('/');
    trimmed
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty() && *name != trimmed)
}

/// One calendar day's total tokens across every model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDayUsage {
    pub day: String,
    pub tokens: u64,
}

/// What the app read from the user's own local harness logs.
///
/// Separate from [`AccountUsage`] on purpose: the provider's account read is
/// the provider's account, while this is the local record, with its own
/// coverage window and its own failure counters. The UI presents them as
/// different sources because they are — neither stands in for the other.
///
/// The counters are the provenance contract. `files_unreadable` and
/// `files_compressed` name the rollouts whose tokens are *not* in these
/// totals, so the UI can say what is missing instead of implying a complete
/// picture.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUsage {
    pub models: Vec<LocalModelUsage>,
    /// Ranked by tokens. Empty when the source records no working directory,
    /// which is a fact about the data rather than a failure to read it.
    #[serde(default)]
    pub projects: Vec<LocalProjectUsage>,
    pub days: Vec<LocalDayUsage>,
    /// API-equivalent cost of every priced model, summed. Zero when nothing
    /// could be priced — paired with `unpriced_tokens` so the two read
    /// together.
    #[serde(rename = "costUsd")]
    pub cost_usd: f64,
    /// Tokens whose model the price list does not cover.
    pub unpriced_tokens: u64,
    pub sessions: u64,
    pub files_scanned: u64,
    pub files_unreadable: u64,
    pub files_compressed: u64,
    pub first_day: Option<String>,
    pub last_day: Option<String>,
}

/// What one scan's per-model token counts came to in money, for the caller to
/// fold into a [`LocalUsage`].
pub struct LocalPricing {
    pub total_cost_usd: f64,
    pub unpriced_tokens: u64,
}

/// The bundled price list, parsed. `None` when it cannot be parsed at all,
/// which leaves every model unpriced rather than pricing against nothing.
pub fn bundled_price_catalog() -> Option<serde_json::Value> {
    serde_json::from_str(include_str!("../../../public/price_list.json")).ok()
}

/// The pure rule, with the catalog already read.
pub fn price_local_model_with_catalog(
    model: &mut LocalModelUsage,
    provider_id: &str,
    catalog: &serde_json::Value,
) -> bool {
    if let Some(name) = listed_model_entry(catalog, provider_id, &model.id)
        .and_then(|entry| entry.get("name"))
        .and_then(serde_json::Value::as_str)
    {
        model.display_name = name.to_string();
    }
    match local_model_cost(catalog, provider_id, model) {
        Some(cost) => {
            model.cost_usd = Some(cost);
            true
        }
        None => {
            model.cost_usd = None;
            false
        }
    }
}

/// Prices local usage rows against the bundled price list.
///
/// This is the exact tier the provider API cannot offer: the logs carry a real
/// per-response split, so cached prompt, fresh prompt, cache writes and
/// completion are each charged their own rate — no blended average and no
/// assumed input share.
///
/// A rate the catalog does not separate falls back to the input rate — the
/// closest published rate for the same class of prompt token. This was found
/// against real data rather than assumed: OpenCode records 145k cache-write
/// tokens for GLM-5.3-Flash, a model the catalog prices at input/output/cache-read
/// but not cache-write, and dropping those rows priced 62% of that model's
/// volume at nothing. A model is unpriced only when the catalog cannot price
/// its ordinary prompt or output tokens at all.
pub fn price_local_models(models: &mut [LocalModelUsage], provider_id: &str) -> LocalPricing {
    price_local_models_with_catalog(
        models,
        provider_id,
        include_str!("../../../public/price_list.json"),
    )
}

pub fn price_local_models_with_catalog(
    models: &mut [LocalModelUsage],
    provider_id: &str,
    catalog: &str,
) -> LocalPricing {
    let Ok(catalog) = serde_json::from_str::<serde_json::Value>(catalog) else {
        return LocalPricing {
            total_cost_usd: 0.0,
            unpriced_tokens: models.iter().map(LocalModelUsage::total_tokens).sum(),
        };
    };

    let mut total_cost_usd = 0.0;
    let mut unpriced_tokens = 0;
    for model in models.iter_mut() {
        if price_local_model_with_catalog(model, provider_id, &catalog) {
            total_cost_usd += model.cost_usd.unwrap_or_default();
        } else {
            unpriced_tokens += model.total_tokens();
        }
    }
    LocalPricing {
        total_cost_usd,
        unpriced_tokens,
    }
}

/// The exact cost of one model's token split, or `None` when the catalog
/// cannot price every class this model actually used.
fn local_model_cost(
    catalog: &serde_json::Value,
    provider_id: &str,
    model: &LocalModelUsage,
) -> Option<f64> {
    let entry = listed_model_entry(catalog, provider_id, &model.id)?;
    let cost = ["cost_per_million", "api_cost_per_million"]
        .into_iter()
        .find_map(|field| entry.get(field))?;
    let rate = |class: &str| cost.get(class).and_then(serde_json::Value::as_f64);

    let input = rate("input")?;
    let output = rate("output")?;
    // Cache reads and cache writes are prompt tokens the vendor does not
    // always price separately. Prefer the specific rate — a catalog that
    // separates them only ever lowers the charge — and fall back to the input
    // rate, which overstates a write rather than dropping the tokens.
    let cache_read = rate("cache_read").unwrap_or(input);
    let cache_write = rate("cache_write").unwrap_or(input);

    let cost = (model.fresh_input() as f64 * input
        + model.cached_input as f64 * cache_read
        + model.cache_write as f64 * cache_write
        + model.output as f64 * output)
        / 1_000_000.0;
    cost.is_finite().then_some(cost)
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
// Kickoff model and effort metadata
// ---------------------------------------------------------------------------

/// One reasoning-effort setting reported by a provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KickoffEffortInfo {
    pub id: String,
    pub label: String,
}

impl KickoffEffortInfo {
    pub fn new(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
        }
    }
}

/// A model currently exposed by its connected harness and present in the
/// bundled price list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KickoffModelInfo {
    pub provider_id: String,
    pub id: String,
    pub label: String,
    pub efforts: Vec<KickoffEffortInfo>,
    pub cheapest: bool,
}

impl KickoffModelInfo {
    pub fn new(
        provider_id: impl Into<String>,
        id: impl Into<String>,
        label: impl Into<String>,
        efforts: Vec<KickoffEffortInfo>,
    ) -> Self {
        Self {
            provider_id: provider_id.into(),
            id: id.into(),
            label: label.into(),
            efforts,
            cheapest: false,
        }
    }

    pub fn lowest_effort(&self) -> Option<&str> {
        self.efforts.first().map(|effort| effort.id.as_str())
    }
}

/// Ranks harness models by listed input plus output price and marks the first
/// entry as the default. The ordering is not a subscription-quota estimate.
pub fn rank_kickoff_models(
    kind: ProviderKind,
    models: Vec<KickoffModelInfo>,
) -> Vec<KickoffModelInfo> {
    rank_kickoff_models_with_catalog(
        kind,
        models,
        include_str!("../../../public/price_list.json"),
    )
}

pub fn kickoff_model_label(provider_id: &str, model_id: &str) -> String {
    let Ok(catalog) =
        serde_json::from_str::<serde_json::Value>(include_str!("../../../public/price_list.json"))
    else {
        return model_id.to_string();
    };
    listed_model_entry(&catalog, provider_id, model_id)
        .and_then(|entry| entry.get("name"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or(model_id)
        .to_string()
}

fn rank_kickoff_models_with_catalog(
    kind: ProviderKind,
    models: Vec<KickoffModelInfo>,
    catalog: &str,
) -> Vec<KickoffModelInfo> {
    let Ok(catalog) = serde_json::from_str::<serde_json::Value>(catalog) else {
        return Vec::new();
    };

    let mut ranked = models
        .into_iter()
        .filter_map(|mut model| {
            if !model_belongs_to_kind(kind, &model.provider_id) {
                return None;
            }
            let price = listed_model_price(&catalog, &model.provider_id, &model.id)?;
            model.cheapest = false;
            Some((price, model))
        })
        .collect::<Vec<_>>();

    ranked.sort_by(|(left_price, left), (right_price, right)| {
        left_price
            .total_cmp(right_price)
            .then_with(|| left.id.cmp(&right.id))
            .then_with(|| left.provider_id.cmp(&right.provider_id))
    });

    let mut models = ranked
        .into_iter()
        .map(|(_, model)| model)
        .collect::<Vec<_>>();
    if let Some(first) = models.first_mut() {
        first.cheapest = true;
    }
    models
}

fn model_belongs_to_kind(kind: ProviderKind, provider_id: &str) -> bool {
    match kind {
        ProviderKind::Codex => provider_id == "openai",
        ProviderKind::Zai => matches!(provider_id, "zai-coding-plan" | "zhipuai-coding-plan"),
        ProviderKind::Minimax => {
            matches!(
                provider_id,
                "minimax-coding-plan" | "minimax-cn-coding-plan"
            )
        }
        ProviderKind::Kimi => matches!(
            provider_id,
            "kimi-for-coding" | "kimi-code-plan-cn" | "kimi-code-plan-global"
        ),
    }
}

fn listed_model_price(
    catalog: &serde_json::Value,
    provider_id: &str,
    model_id: &str,
) -> Option<f64> {
    let model = listed_model_entry(catalog, provider_id, model_id)?;
    [
        model.get("cost_per_million"),
        model.get("api_cost_per_million"),
    ]
    .into_iter()
    .flatten()
    .find_map(|cost| {
        let input = cost.get("input")?.as_f64()?;
        let output = cost.get("output")?.as_f64()?;
        let total = input + output;
        (input >= 0.0 && output >= 0.0 && total.is_finite()).then_some(total)
    })
}

fn listed_model_entry<'a>(
    catalog: &'a serde_json::Value,
    provider_id: &str,
    model_id: &str,
) -> Option<&'a serde_json::Value> {
    let price_provider = if provider_id == "kimi-for-coding" {
        "kimi-code-plan-global"
    } else {
        provider_id
    };
    catalog
        .get("providers")?
        .get(price_provider)?
        .get("models")?
        .get(model_id)
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
    fn model_usage_rows_serialize_camel_cased_for_the_client() {
        let model = ModelUsage {
            id: "glm-5.3-flash".to_string(),
            display_name: "GLM-5.3-Flash".to_string(),
            tokens: 2_247_671_759,
            requests: None,
        };
        let json = serde_json::to_value(&model).expect("serializes");
        assert_eq!(json["id"], "glm-5.3-flash");
        assert_eq!(json["displayName"], "GLM-5.3-Flash");
        assert_eq!(json["tokens"], 2_247_671_759u64);
        assert_eq!(json["requests"], serde_json::Value::Null);
    }

    #[test]
    fn an_account_usage_without_models_still_decodes() {
        // `models` is `#[serde(default)]`, so a payload from an older build
        // (or a provider that totals only) must not fail the decode.
        let json = r#"{"fetchedAt":1,"summary":{},"dailyUsageBuckets":[]}"#;
        let usage: AccountUsage = serde_json::from_str(json).expect("decodes");
        assert!(usage.models.is_empty());
        assert_eq!(usage.local, None);
    }

    #[test]
    fn a_local_reading_reaches_the_client_with_its_cost_in_camel_case() {
        let usage = AccountUsage {
            fetched_at: 1,
            summary: AccountUsageSummary {
                total_tokens: None,
                peak_daily_tokens: None,
                longest_running_turn_sec: None,
                current_streak_days: None,
                longest_streak_days: None,
                total_requests: None,
            },
            daily_usage_buckets: Vec::new(),
            models: Vec::new(),
            local: Some(LocalUsage {
                projects: Vec::new(),
                models: vec![LocalModelUsage {
                    id: "gpt-6-luna".to_string(),
                    display_name: "GPT-6 Luna".to_string(),
                    input: 10,
                    cached_input: 4,
                    cache_write: 0,
                    output: 2,
                    reasoning: 1,
                    responses: 1,
                    cost_usd: Some(0.5),
                }],
                days: Vec::new(),
                cost_usd: 0.5,
                unpriced_tokens: 0,
                sessions: 1,
                files_scanned: 1,
                files_unreadable: 0,
                files_compressed: 0,
                first_day: Some("2026-10-01".to_string()),
                last_day: Some("2026-10-02".to_string()),
            }),
            window_days: None,
        };

        let json = serde_json::to_value(&usage).expect("serializes");
        let local = &json["local"];
        assert_eq!(local["costUsd"], 0.5);
        assert_eq!(local["unpricedTokens"], 0u64);
        assert_eq!(local["filesCompressed"], 0u64);
        assert_eq!(local["models"][0]["displayName"], "GPT-6 Luna");
        assert_eq!(local["models"][0]["cachedInput"], 4u64);
        assert_eq!(local["firstDay"], "2026-10-01");
    }

    /// A split at real magnitudes — the research worked example saw Codex pass a
    /// billion prompt tokens all-time — exercising every token class at known
    /// rates: fresh 600M × $2, cached 400M × $0.20, output 200M × $12 =
    /// **$3,680**.
    fn local_model(id: &str) -> LocalModelUsage {
        LocalModelUsage {
            id: id.to_string(),
            display_name: id.to_string(),
            input: 1_000_000_000,
            cached_input: 400_000_000,
            cache_write: 0,
            output: 200_000_000,
            reasoning: 120_000_000,
            responses: 5,
            cost_usd: None,
        }
    }

    const SPLIT_CATALOG: &str = r#"{"providers":{"openai":{"models":{
        "gpt-5.6-terra":{"name":"GPT-5.6 Terra","cost_per_million":{
            "input":2,"output":12,"cache_read":0.2,"cache_write":2.5}},
        "gpt-5.5":{"name":"GPT-5.5","cost_per_million":{"input":5,"output":30,"cache_read":0.5}}
    }}}}"#;

    #[test]
    fn local_usage_prices_the_real_split_not_a_blended_average() {
        let mut models = vec![local_model("gpt-5.6-terra")];
        let priced = price_local_models_with_catalog(&mut models, "openai", SPLIT_CATALOG);

        assert_eq!(models[0].display_name, "GPT-5.6 Terra");
        let cost = models[0].cost_usd.expect("priced");
        assert!((cost - 3_680.0).abs() < 0.0001, "cost was {cost}");
        assert!((priced.total_cost_usd - 3_680.0).abs() < 0.0001);
        assert_eq!(priced.unpriced_tokens, 0);
    }

    #[test]
    fn cache_writes_are_priced_at_their_own_rate() {
        let mut model = local_model("gpt-5.6-terra");
        model.cache_write = 1_000_000_000;
        let mut models = vec![model];
        let priced = price_local_models_with_catalog(&mut models, "openai", SPLIT_CATALOG);

        // The same 1B tokens as fresh prompt would cost $2,000; at the $2.50
        // write rate they cost $2,500.
        assert!((models[0].cost_usd.expect("priced") - 6_180.0).abs() < 0.0001);
        assert!((priced.total_cost_usd - 6_180.0).abs() < 0.0001);
    }

    #[test]
    fn a_model_the_list_does_not_carry_stays_unpriced_not_free() {
        let mut models = vec![local_model("gpt-5.6-terra"), local_model("gpt-9-imaginary")];
        let priced = price_local_models_with_catalog(&mut models, "openai", SPLIT_CATALOG);

        assert!(models[1].cost_usd.is_none());
        assert_eq!(models[1].display_name, "gpt-9-imaginary");
        assert_eq!(priced.unpriced_tokens, 1_200_000_000);
        assert!((priced.total_cost_usd - 3_680.0).abs() < 0.0001);
    }

    #[test]
    fn a_write_rate_the_catalog_omits_charges_prompt_at_the_input_rate() {
        // GPT-5.5 lists no cache-write rate. Charging writes at the input rate
        // overstates them slightly; dropping the model's whole volume because
        // of a missing rate understates far more (see the real-data note on
        // `price_local_models`).
        let mut model = local_model("gpt-5.5");
        model.cache_write = 1_000_000_000;
        let mut models = vec![model];
        let priced = price_local_models_with_catalog(&mut models, "openai", SPLIT_CATALOG);

        // fresh 600M × $5 + cached 400M × $0.5 + writes 1B × $5 + output
        // 200M × $30 = $14,200.
        assert!((models[0].cost_usd.expect("priced") - 14_200.0).abs() < 0.001);
        assert!((priced.total_cost_usd - 14_200.0).abs() < 0.001);
        assert_eq!(priced.unpriced_tokens, 0);
    }

    #[test]
    fn a_model_the_catalog_cannot_price_at_all_stays_unpriced() {
        // No input and no output rate: there is nothing to fall back from.
        let catalog = r#"{"providers":{"zai-coding-plan":{"models":{
            "glm-mystery":{"name":"GLM Mystery"}
        }}}}"#;
        let mut models = vec![local_model("glm-mystery")];
        let priced = price_local_models_with_catalog(&mut models, "zai-coding-plan", catalog);

        assert!(models[0].cost_usd.is_none());
        assert_eq!(priced.unpriced_tokens, 1_200_000_000);
        assert_eq!(priced.total_cost_usd, 0.0);
    }

    #[test]
    fn a_missing_rate_costs_nothing_when_the_model_never_used_it() {
        // The same GPT-5.5 with zero cache writes prices fine.
        let mut models = vec![local_model("gpt-5.5")];
        let priced = price_local_models_with_catalog(&mut models, "openai", SPLIT_CATALOG);

        assert!(models[0].cost_usd.is_some());
        assert_eq!(priced.unpriced_tokens, 0);
    }

    #[test]
    fn the_api_reference_rate_prices_a_model_with_no_direct_charge() {
        let catalog = r#"{"providers":{"zai-coding-plan":{"models":{
            "glm-5.3":{"name":"GLM-5.3","api_cost_per_million":{"input":1.4,"output":4.4}}
        }}}}"#;
        let mut models = vec![local_model("glm-5.3")];
        price_local_models_with_catalog(&mut models, "zai-coding-plan", catalog);

        // fresh 600M × 1.4 + cached 400M × 1.4 + output 200M × 4.4 = $2,280.
        // No cache-read rate listed, so cached prompt falls back to the input
        // rate rather than being dropped from the total.
        assert!((models[0].cost_usd.expect("priced") - 2_280.0).abs() < 0.0001);
    }

    #[test]
    fn ranks_only_available_models_with_listed_prices() {
        let models = vec![
            KickoffModelInfo::new("openai", "expensive", "Expensive", vec![]),
            KickoffModelInfo::new("openai", "cheap", "Cheap", vec![]),
            KickoffModelInfo::new("openai", "unpriced", "Unpriced", vec![]),
        ];
        let prices = r#"{"providers":{"openai":{"models":{
            "expensive":{"cost_per_million":{"input":2,"output":2}},
            "cheap":{"cost_per_million":{"input":0.1,"output":0.2}},
            "unpriced":{"subscription_included":true}
        }}}}"#;

        let ranked = rank_kickoff_models_with_catalog(ProviderKind::Codex, models, prices);

        assert_eq!(
            ranked
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["cheap", "expensive"]
        );
        assert!(ranked[0].cheapest);
        assert!(!ranked[1].cheapest);
    }

    #[test]
    fn subscription_reference_prices_rank_without_becoming_zero_cost() {
        let models = vec![
            KickoffModelInfo::new("zai-coding-plan", "glm-5.3", "GLM-5.3", vec![]),
            KickoffModelInfo::new("zai-coding-plan", "glm-5.3-flash", "GLM-5.3 Flash", vec![]),
            KickoffModelInfo::new("zai-coding-plan", "no-price", "No price", vec![]),
        ];
        let prices = r#"{"providers":{"zai-coding-plan":{"models":{
            "glm-5.3":{"subscription_included":true,"api_cost_per_million":{"input":1.4,"output":4.4}},
            "glm-5.3-flash":{"subscription_included":true,"api_cost_per_million":{"input":0.15,"output":0.5}},
            "no-price":{"subscription_included":true}
        }}}}"#;

        let ranked = rank_kickoff_models_with_catalog(ProviderKind::Zai, models, prices);

        assert_eq!(
            ranked
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["glm-5.3-flash", "glm-5.3"]
        );
    }

    #[test]
    fn actual_prices_take_precedence_over_api_reference_prices() {
        let models = vec![
            KickoffModelInfo::new("minimax-coding-plan", "actual", "Actual", vec![]),
            KickoffModelInfo::new("minimax-coding-plan", "reference", "Reference", vec![]),
        ];
        let prices = r#"{"providers":{"minimax-coding-plan":{"models":{
            "actual":{"cost_per_million":{"input":1,"output":1},"api_cost_per_million":{"input":0.01,"output":0.01}},
            "reference":{"api_cost_per_million":{"input":0.5,"output":0.5}}
        }}}}"#;

        let ranked = rank_kickoff_models_with_catalog(ProviderKind::Minimax, models, prices);

        assert_eq!(ranked[0].id, "reference");
        assert_eq!(ranked[1].id, "actual");
    }
}
