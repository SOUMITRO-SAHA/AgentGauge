//! The Kimi code-plan integration.
//!
//! Everything this provider knows comes from two read-only sources: OpenCode
//! (which plan is connected, and the credential OpenCode already stores) and
//! Kimi's usage endpoint. Nothing here can spend the plan's quota.

pub(crate) mod protocol;

use crate::modules::providers::coding_plan::{self, PlanSpec};
use crate::modules::providers::kimi::protocol::{
    decode_auth_failure, decode_usages, is_auth_refusal, USAGES_PATH,
};
use crate::shared::domain::{
    AccountUsage, KickoffModelInfo, PlanKind, ProviderKind, UsageSnapshot,
};
use crate::shared::error::Error;
use crate::shared::provider::{PingOutcome, Provider, ProviderStatus};

/// The plan ids this integration reads, in preference order: the China plans
/// first (`.com` host), then the global plan (`.ai` host).
const FAMILY: [&str; 3] = [
    "kimi-for-coding",
    "kimi-code-plan-cn",
    "kimi-code-plan-global",
];

pub struct KimiProvider;

impl KimiProvider {
    pub fn new() -> Self {
        Self
    }

    fn spec() -> PlanSpec {
        PlanSpec {
            kind: ProviderKind::Kimi,
            family: &FAMILY,
            path: USAGES_PATH,
            bearer: true,
        }
    }
}

impl Provider for KimiProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Kimi
    }

    fn status(&self) -> ProviderStatus {
        coding_plan::opencode_status(ProviderKind::Kimi)
    }

    fn read_usage(&self) -> Result<UsageSnapshot, Error> {
        coding_plan::read_usage(&Self::spec(), |payload, kind, now_ms| {
            if is_auth_refusal(payload) {
                return Ok(decode_auth_failure(kind));
            }
            decode_usages(payload, kind, now_ms)
        })
    }

    fn read_account_usage(&self) -> Result<AccountUsage, Error> {
        Err(coding_plan::unsupported(
            ProviderKind::Kimi,
            "account activity",
        ))
    }

    fn account(&self) -> Result<Option<PlanKind>, Error> {
        // Kimi's reply carries no plan tier, so there is nothing to report.
        Ok(None)
    }

    fn send_ping(&self, _prompt: &str) -> Result<PingOutcome, Error> {
        Err(coding_plan::unsupported(ProviderKind::Kimi, "a ping"))
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
    fn the_spec_is_sound() {
        coding_plan::assert_spec_is_sound(&KimiProvider::spec());
    }

    #[test]
    fn the_provider_speaks_for_kimi() {
        let provider = KimiProvider::new();
        assert_eq!(provider.kind(), ProviderKind::Kimi);
        assert_eq!(provider.status().kind, ProviderKind::Kimi);
    }
}
