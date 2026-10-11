//! The Z.AI / Zhipu coding-plan integration.
//!
//! Everything this provider knows comes from two read-only sources: OpenCode
//! (which plan is connected, and the credential OpenCode already stores) and
//! Z.AI's quota endpoint. Nothing here can spend the plan's quota.

pub(crate) mod protocol;

use crate::modules::providers::coding_plan::{self, PlanSpec};
use crate::modules::providers::zai::protocol::{
    decode_auth_failure, decode_model_usage, decode_quota, is_auth_refusal, model_usage_query,
    QUOTA_PATH,
};
use crate::shared::domain::{
    AccountUsage, KickoffModelInfo, PlanKind, ProviderKind, UsageSnapshot,
};
use crate::shared::error::Error;
use crate::shared::provider::{PingOutcome, Provider, ProviderStatus};

/// The plan ids this integration reads, in preference order: the global plan
/// first, then the China plan, because a user connected to both is far more
/// likely to be spending the global one.
const FAMILY: [&str; 2] = ["zai-coding-plan", "zhipuai-coding-plan"];

pub struct ZaiProvider;

impl ZaiProvider {
    pub fn new() -> Self {
        Self
    }

    fn spec() -> PlanSpec {
        PlanSpec {
            kind: ProviderKind::Zai,
            family: &FAMILY,
            path: QUOTA_PATH,
            bearer: false,
        }
    }
}

impl Provider for ZaiProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Zai
    }

    fn status(&self) -> ProviderStatus {
        coding_plan::opencode_status(ProviderKind::Zai)
    }

    fn read_usage(&self) -> Result<UsageSnapshot, Error> {
        coding_plan::read_usage(&Self::spec(), |payload, kind, now_ms| {
            // Z.AI reports a rejected credential inside HTTP 200; that is a
            // "sign in again" state, not a broken read.
            if is_auth_refusal(payload) {
                return Ok(decode_auth_failure(kind));
            }
            decode_quota(payload, kind, now_ms)
        })
    }

    fn read_account_usage(&self) -> Result<AccountUsage, Error> {
        let now_ms = crate::shared::clock::Clock::now_ms(&crate::shared::clock::SystemClock);
        coding_plan::read_monitor_json(
            &Self::spec(),
            &model_usage_query(now_ms),
            decode_model_usage,
        )
    }

    fn account(&self) -> Result<Option<PlanKind>, Error> {
        // The plan tier arrives inside the quota reply, so there is no
        // separate plan read to make here.
        Ok(None)
    }

    fn send_ping(&self, _prompt: &str) -> Result<PingOutcome, Error> {
        Err(coding_plan::unsupported(ProviderKind::Zai, "a ping"))
    }

    fn kickoff_models(&self) -> Result<Vec<KickoffModelInfo>, Error> {
        coding_plan::kickoff_models(&Self::spec(), protocol::kickoff_efforts)
    }

    fn send_kickoff(&self, prompt: &str, model: &str, effort: &str) -> Result<PingOutcome, Error> {
        coding_plan::send_kickoff(
            &Self::spec(),
            prompt,
            model,
            effort,
            protocol::kickoff_body,
            protocol::decode_kickoff_reply,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "live probe: hits the real Z.AI endpoint with the key OpenCode stores"]
    fn live_zai_read_usage_prints_the_snapshot() {
        match crate::modules::providers::coding_plan::read_usage(
            &ZaiProvider::spec(),
            |payload, kind, now_ms| {
                if crate::modules::providers::zai::protocol::is_auth_refusal(payload) {
                    return Ok(crate::modules::providers::zai::protocol::decode_auth_failure(kind));
                }
                crate::modules::providers::zai::protocol::decode_quota(payload, kind, now_ms)
            },
        ) {
            Ok(snapshot) => println!(
                "LIVE_ZAI>>> freshness={:?} plan={:?} permission={:?} fetched_at={} wall_now={} stamp_age_ms={} windows={:?} five_hour_used={:?} five_hour_resets={:?}",
                snapshot.freshness,
                snapshot.plan,
                snapshot.permission,
                snapshot.fetched_at.unwrap_or(0),
                crate::shared::clock::Clock::now_ms(&crate::shared::clock::SystemClock),
                crate::shared::clock::Clock::now_ms(&crate::shared::clock::SystemClock)
                    - snapshot.fetched_at.unwrap_or(0),
                snapshot.windows.len(),
                snapshot.five_hour.as_ref().map(|w| w.used_percent),
                snapshot.five_hour.as_ref().and_then(|w| w.resets_at),
            ),
            Err(error) => println!("LIVE_ZAI_ERR>>> {:?} {}", error.kind, error.message),
        }
    }

    #[test]
    #[ignore = "live probe: hits the real Z.AI endpoint with the key OpenCode stores"]
    fn live_zai_model_usage_prints_the_account_usage() {
        use crate::modules::opencode::OpenCodeCatalog;
        use crate::modules::providers::coding_plan::{plan_request, PlanRequest};
        use crate::modules::providers::http;

        let now_ms = crate::shared::clock::Clock::now_ms(&crate::shared::clock::SystemClock);
        let spec = ZaiProvider::spec();
        let catalog = OpenCodeCatalog::read().expect("opencode reads");
        let PlanRequest::Fetch { url, auth } =
            plan_request(&catalog, &spec, &protocol::model_usage_query(now_ms))
        else {
            panic!("expected a fetch");
        };
        let payload = http::get_json(&url, &auth).expect("the monitor answers");
        println!("LIVE_ZAI_MODEL_USAGE_RAW>>> {payload}");
        match protocol::decode_model_usage(&payload, now_ms) {
            Ok(usage) => println!(
                "LIVE_ZAI_ANALYTICS>>> fetched_at={} window_days={:?} total_tokens={:?} total_requests={:?} peak={:?} streaks=({:?},{:?}) buckets={}",
                usage.fetched_at,
                usage.window_days,
                usage.summary.total_tokens,
                usage.summary.total_requests,
                usage.summary.peak_daily_tokens,
                usage.summary.current_streak_days,
                usage.summary.longest_streak_days,
                usage.daily_usage_buckets.len(),
            ),
            Err(error) => println!("LIVE_ZAI_ANALYTICS_ERR>>> {:?} {}", error.kind, error.message),
        }
    }

    #[test]
    fn the_spec_is_sound() {
        coding_plan::assert_spec_is_sound(&ZaiProvider::spec());
    }

    #[test]
    fn the_provider_speaks_for_zai() {
        let provider = ZaiProvider::new();
        assert_eq!(provider.kind(), ProviderKind::Zai);
        assert_eq!(provider.status().kind, ProviderKind::Zai);
    }
}
