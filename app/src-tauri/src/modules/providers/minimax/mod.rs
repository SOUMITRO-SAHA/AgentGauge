//! The MiniMax token-plan integration.
//!
//! Everything this provider knows comes from two read-only sources: OpenCode
//! (which plan is connected, and the credential OpenCode already stores) and
//! MiniMax's token-plan usage endpoint. Nothing here can spend the plan's
//! quota.

pub(crate) mod protocol;

use crate::modules::providers::coding_plan::{self, PlanSpec};
use crate::modules::providers::minimax::protocol::{
    decode_auth_failure, decode_remains, is_auth_refusal, REMAINS_PATH,
};
use crate::shared::domain::{
    AccountUsage, KickoffModelInfo, PlanKind, ProviderKind, UsageSnapshot,
};
use crate::shared::error::Error;
use crate::shared::provider::{PingOutcome, Provider, ProviderStatus};

/// The plan ids this integration reads, in preference order: the global plan
/// first, then the China plan.
const FAMILY: [&str; 2] = ["minimax-coding-plan", "minimax-cn-coding-plan"];

pub struct MinimaxProvider;

impl MinimaxProvider {
    pub fn new() -> Self {
        Self
    }

    fn spec() -> PlanSpec {
        PlanSpec {
            kind: ProviderKind::Minimax,
            family: &FAMILY,
            path: REMAINS_PATH,
            bearer: true,
        }
    }
}

impl Provider for MinimaxProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Minimax
    }

    fn status(&self) -> ProviderStatus {
        coding_plan::opencode_status(ProviderKind::Minimax)
    }

    fn read_usage(&self) -> Result<UsageSnapshot, Error> {
        coding_plan::read_usage(&Self::spec(), |payload, kind, now_ms| {
            // MiniMax reports a rejected credential inside its own envelope
            // with a 200 status; that is a "reconnect it" state, not a broken
            // read.
            if is_auth_refusal(payload) {
                return Ok(decode_auth_failure(kind));
            }
            decode_remains(payload, kind, now_ms)
        })
    }

    fn read_account_usage(&self) -> Result<AccountUsage, Error> {
        Err(coding_plan::unsupported(
            ProviderKind::Minimax,
            "account activity",
        ))
    }

    fn account(&self) -> Result<Option<PlanKind>, Error> {
        // MiniMax's reply carries no plan tier, so there is nothing to report.
        Ok(None)
    }

    fn send_ping(&self, _prompt: &str) -> Result<PingOutcome, Error> {
        Err(coding_plan::unsupported(ProviderKind::Minimax, "a ping"))
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
        coding_plan::assert_spec_is_sound(&MinimaxProvider::spec());
    }

    #[test]
    fn the_provider_speaks_for_minimax() {
        let provider = MinimaxProvider::new();
        assert_eq!(provider.kind(), ProviderKind::Minimax);
        assert_eq!(provider.status().kind, ProviderKind::Minimax);
    }
}
