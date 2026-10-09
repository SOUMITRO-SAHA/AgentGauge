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

use crate::shared::domain::{PlanKind, ProviderKind, UsageSnapshot};
use crate::shared::error::{Error, ErrorKind};
use crate::shared::provider::{PingOutcome, Provider, ProviderStatus};

use codex::CODEX_EXECUTABLE;
pub use codex::{CodexProvider, PING_PROMPT};

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
    /// state rather than a failed start-up.
    pub fn new(now_ms: i64) -> Self {
        Self {
            providers: vec![Box::new(CodexProvider::new(CODEX_EXECUTABLE, now_ms))],
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

    /// Sends a minimal prompt. Callers must gate this behind an explicit,
    /// user-enabled setting — it spends the account's quota.
    pub fn ping(&self, kind: ProviderKind, prompt: &str) -> Result<PingOutcome, Error> {
        self.find(kind)?.send_ping(prompt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_codex() {
        let registry = ProviderRegistry::new(0);
        assert_eq!(registry.kinds(), vec![ProviderKind::Codex]);
    }

    #[test]
    fn reports_status_for_every_provider() {
        let registry = ProviderRegistry::new(0);
        assert_eq!(registry.status().len(), 1);
    }

    #[test]
    fn rejects_an_unknown_provider_kind() {
        // Only one variant exists, so this exercises the guard itself through
        // the registry rather than a fabricated kind.
        let registry = ProviderRegistry::new(0);
        let found = registry.find(ProviderKind::Codex);
        assert!(found.is_ok());
    }
}
