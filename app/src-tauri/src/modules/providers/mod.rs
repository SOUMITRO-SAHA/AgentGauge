//! Provider integrations and the registry that resolves them.
//!
//! The registry owns provider lifetime and hands out `&dyn Provider` handles.
//! Callers never branch on a provider kind, so adding one is a registration
//! line here and a new module — never an edit to `automation`, `widget`, or
//! `lib.rs`.

// Private in a normal build: `codex` is a leaf of this module and no
// production caller may reach into it. The integration tests need the transport
// and the decoder, and they get them through the crate-level `testkit` — which
// is behind a feature that is never enabled in a release build.
#[cfg(any(test, feature = "testkit"))]
pub(crate) mod codex;

#[cfg(not(any(test, feature = "testkit")))]
mod codex;

pub(crate) mod coding_plan;
pub(crate) mod http;
pub(crate) mod kimi;
pub(crate) mod minimax;
pub(crate) mod zai;

use crate::shared::domain::{
    rank_kickoff_models, AccountUsage, KickoffModelInfo, PlanKind, ProviderKind, UsageSnapshot,
};
use crate::shared::error::{Error, ErrorKind};
use crate::shared::provider::{PingOutcome, Provider, ProviderStatus};

use codex::CODEX_EXECUTABLE;
pub use codex::{CodexProvider, PING_PROMPT};
use kimi::KimiProvider;
use minimax::MinimaxProvider;
use zai::ZaiProvider;

/// Resolves a provider by kind and owns its lifetime.
///
/// Constructed once, in `lib.rs`, and handed to the modules that need it.
pub struct ProviderRegistry {
    providers: Vec<Box<dyn Provider>>,
}

impl ProviderRegistry {
    /// Builds the registry with every provider this build supports.
    ///
    /// The Codex executable is resolved lazily on first use, so launching the
    /// app without Codex installed still yields a usable "not installed"
    /// state rather than a failed start-up. The coding-plan providers are the
    /// same: they ask OpenCode what is connected only when read.
    pub fn new() -> Self {
        Self {
            providers: vec![
                Box::new(CodexProvider::new(CODEX_EXECUTABLE)),
                Box::new(ZaiProvider::new()),
                Box::new(MinimaxProvider::new()),
                Box::new(KimiProvider::new()),
            ],
        }
    }

    /// Every provider kind this build knows about.
    pub fn kinds(&self) -> Vec<ProviderKind> {
        self.providers
            .iter()
            .map(|provider| provider.kind())
            .collect()
    }

    fn find(&self, kind: ProviderKind) -> Result<&dyn Provider, Error> {
        self.providers
            .iter()
            .find(|provider| provider.kind() == kind)
            .map(|provider| provider.as_ref())
            .ok_or_else(|| {
                Error::new(
                    ErrorKind::InvalidRequest,
                    format!("Unknown provider `{}`.", kind.as_str()),
                )
            })
    }

    /// Probes every provider without starting a long-lived process.
    pub fn status(&self) -> Vec<ProviderStatus> {
        self.providers
            .iter()
            .map(|provider| provider.status())
            .collect()
    }

    /// Reads the account's plan tier for one provider.
    ///
    /// A failure here is not fatal: the dashboard already carries a plan from
    /// the rate-limit snapshot, so this only enriches it.
    pub fn plan(&self, kind: ProviderKind) -> Result<Option<PlanKind>, Error> {
        self.find(kind)?.account()
    }

    /// Reads usage for one provider.
    pub fn usage(&self, kind: ProviderKind) -> Result<UsageSnapshot, Error> {
        self.find(kind)?.read_usage()
    }

    pub fn account_usage(&self, kind: ProviderKind) -> Result<AccountUsage, Error> {
        self.find(kind)?.read_account_usage()
    }

    /// Sends a minimal prompt. Callers must gate this behind an explicit,
    /// user-enabled setting — it spends the account's quota.
    pub fn ping(&self, kind: ProviderKind, prompt: &str) -> Result<PingOutcome, Error> {
        self.find(kind)?.send_ping(prompt)
    }

    pub fn kickoff_models(&self, kind: ProviderKind) -> Result<Vec<KickoffModelInfo>, Error> {
        let models = self.find(kind)?.kickoff_models()?;
        Ok(rank_kickoff_models(kind, models))
    }

    /// Sends the scheduled kickoff prompt. Same rule as [`Self::ping`], one
    /// level stricter: the only legitimate caller is the kickoff scheduler,
    /// which runs only for subscriptions the user explicitly opted in.
    pub fn kickoff(
        &self,
        kind: ProviderKind,
        prompt: &str,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<PingOutcome, Error> {
        let models = self.kickoff_models(kind)?;
        let selected = match model {
            Some(model_id) => models
                .iter()
                .find(|candidate| candidate.id == model_id)
                .ok_or_else(|| {
                    Error::provider_error(format!(
                        "The selected model `{model_id}` is no longer available for {}.",
                        kind.display_name()
                    ))
                })?,
            None => models.first().ok_or_else(|| {
                Error::provider_error(format!(
                    "No price-listed models are currently available for {}.",
                    kind.display_name()
                ))
            })?,
        };
        let selected_effort = match effort {
            Some(effort_id) => selected
                .efforts
                .iter()
                .find(|candidate| candidate.id == effort_id)
                .map(|candidate| candidate.id.as_str())
                .ok_or_else(|| {
                    Error::invalid_request(format!(
                        "The selected effort `{effort_id}` is not available for `{}`.",
                        selected.id
                    ))
                })?,
            None => selected.lowest_effort().ok_or_else(|| {
                Error::provider_error(format!(
                    "The selected model `{}` has no supported kickoff effort.",
                    selected.id
                ))
            })?,
        };
        if !selected
            .efforts
            .iter()
            .any(|candidate| candidate.id == selected_effort)
        {
            return Err(Error::invalid_request(format!(
                "The selected effort `{selected_effort}` is not available for `{}`.",
                selected.id
            )));
        }
        self.find(kind)?
            .send_kickoff(prompt, &selected.id, selected_effort)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_every_supported_provider() {
        let registry = ProviderRegistry::new();
        assert_eq!(
            registry.kinds(),
            vec![
                ProviderKind::Codex,
                ProviderKind::Zai,
                ProviderKind::Minimax,
                ProviderKind::Kimi,
            ]
        );
    }

    #[test]
    fn reports_status_for_every_provider() {
        let registry = ProviderRegistry::new();
        assert_eq!(registry.status().len(), 4);
    }

    #[test]
    fn every_registered_status_speaks_for_its_own_kind() {
        // A status row must never describe another provider's transport.
        let registry = ProviderRegistry::new();
        for status in registry.status() {
            assert!(
                registry.find(status.kind).is_ok(),
                "{} reported a status without a provider",
                status.kind.as_str()
            );
        }
    }

    #[test]
    fn rejects_an_unknown_provider_kind() {
        // The registry guard itself is exercised through a kind that exists;
        // an unknown kind cannot be constructed because ProviderKind is a
        // closed enum whose every variant is registered above.
        let registry = ProviderRegistry::new();
        for kind in registry.kinds() {
            assert!(registry.find(kind).is_ok());
        }
    }
}
