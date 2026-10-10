//! The Z.AI / Zhipu coding-plan integration.
//!
//! Everything this provider knows comes from two read-only sources: OpenCode
//! (which plan is connected, and the credential OpenCode already stores) and
//! Z.AI's quota endpoint. Nothing here can spend the plan's quota.

pub(crate) mod protocol;

use crate::modules::providers::coding_plan::{self, PlanSpec};
use crate::modules::providers::zai::protocol::{
    decode_auth_failure, decode_quota, is_auth_refusal, QUOTA_PATH,
};
use crate::shared::domain::{AccountUsage, PlanKind, ProviderKind, UsageSnapshot};
use crate::shared::error::Error;
use crate::shared::provider::{PingOutcome, Provider, ProviderStatus};

/// The plan ids this integration reads, in preference order: the global plan
/// first, then the China plan, because a user connected to both is far more
/// likely to be spending the global one.
const FAMILY: [&str; 2] = ["zai-coding-plan", "zhipuai-coding-plan"];

pub struct ZaiProvider {
    now_ms: i64,
}

impl ZaiProvider {
    pub fn new(now_ms: i64) -> Self {
        Self { now_ms }
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
        coding_plan::read_usage(&Self::spec(), self.now_ms, |payload, kind, now_ms| {
            // Z.AI reports a rejected credential inside HTTP 200; that is a
            // "sign in again" state, not a broken read.
            if is_auth_refusal(payload) {
                return Ok(decode_auth_failure(kind));
            }
            decode_quota(payload, kind, now_ms)
        })
    }

    fn read_account_usage(&self) -> Result<AccountUsage, Error> {
        Err(coding_plan::unsupported(
            ProviderKind::Zai,
            "account activity",
        ))
    }

    fn account(&self) -> Result<Option<PlanKind>, Error> {
        // The plan tier arrives inside the quota reply, so there is no
        // separate plan read to make here.
        Ok(None)
    }

    fn send_ping(&self, _prompt: &str) -> Result<PingOutcome, Error> {
        Err(coding_plan::unsupported(ProviderKind::Zai, "a ping"))
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
            0,
            |payload, kind, now_ms| {
                if crate::modules::providers::zai::protocol::is_auth_refusal(payload) {
                    return Ok(crate::modules::providers::zai::protocol::decode_auth_failure(kind));
                }
                crate::modules::providers::zai::protocol::decode_quota(payload, kind, now_ms)
            },
        ) {
            Ok(snapshot) => println!(
                "LIVE_ZAI>>> freshness={:?} plan={:?} windows={:?} five_hour_used={:?}",
                snapshot.freshness,
                snapshot.plan,
                snapshot.windows.len(),
                snapshot.five_hour.as_ref().map(|w| w.used_percent)
            ),
            Err(error) => println!("LIVE_ZAI_ERR>>> {:?} {}", error.kind, error.message),
        }
    }

    #[test]
    fn the_spec_is_sound() {
        coding_plan::assert_spec_is_sound(&ZaiProvider::spec());
    }

    #[test]
    fn the_provider_speaks_for_zai() {
        let provider = ZaiProvider::new(0);
        assert_eq!(provider.kind(), ProviderKind::Zai);
        assert_eq!(provider.status().kind, ProviderKind::Zai);
    }
}
