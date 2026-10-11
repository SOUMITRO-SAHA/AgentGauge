//! The provider contract.
//!
//! Defined here, in `shared/`, rather than in `modules/providers/` so that
//! `automation` and `widget` depend on the *trait* and never on a sibling
//! module's internals. Adding a provider must not require editing either.

use serde::{Deserialize, Serialize};

use crate::shared::domain::{AccountUsage, ProviderKind, UsageSnapshot};
use crate::shared::error::Error;

/// What a provider can tell us about itself, checked before anything else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub kind: ProviderKind,
    /// The executable we expect to find, for the error message.
    pub executable: String,
    /// Whether the executable resolves and reports a version.
    pub installed: bool,
    /// Reported version string, when we could read one.
    pub version: Option<String>,
    /// Why the provider is unusable. Present whenever `installed` is false.
    pub reason: Option<String>,
}

/// A read-only capability: read usage, optionally send a minimal prompt.
///
/// Implementations must be cheap to call and must never mutate an account
/// except through [`Provider::send_ping`], which the caller must have
/// explicitly enabled.
pub trait Provider: Send + Sync {
    /// Which provider this is.
    fn kind(&self) -> ProviderKind;

    /// Probes for the executable. Must not start a long-lived process.
    fn status(&self) -> ProviderStatus;

    /// Reads current usage. Implementations return an
    /// `Unavailable` snapshot rather than an `Err` for "no data yet", so the
    /// UI renders a state instead of a failure.
    fn read_usage(&self) -> Result<UsageSnapshot, Error>;

    /// Reads account-wide token activity after the user explicitly opts in.
    fn read_account_usage(&self) -> Result<AccountUsage, Error>;

    /// Reads the account's plan tier, when the provider reports one.
    ///
    /// Separate from `read_usage` because the plan is not a usage value and not
    /// every account has one (an API-key account does not).
    fn account(&self) -> Result<Option<crate::shared::domain::PlanKind>, Error>;

    /// Sends a minimal prompt and reports whether the account accepted it.
    ///
    /// This consumes quota; it exists for an explicitly enabled automation, not
    /// as a side effect of reading.
    fn send_ping(&self, prompt: &str) -> Result<PingOutcome, Error>;

    /// Sends the scheduled kickoff prompt with an explicit model.
    ///
    /// `None` selects the provider's cheapest default. Like
    /// [`Provider::send_ping`] this spends quota: only the kickoff scheduler —
    /// behind the user's explicit per-subscription opt-in — may call it on a
    /// timer.
    fn send_kickoff(&self, prompt: &str, model: Option<&str>) -> Result<PingOutcome, Error>;
}

/// The result of a ping, including the fresh reading that followed it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingOutcome {
    pub accepted: bool,
    /// The provider's reply text, truncated. Empty when the turn produced no
    /// agent message.
    pub reply: String,
    /// A reading taken after the turn, so the caller can see the effect.
    pub usage: Option<UsageSnapshot>,
    /// Why a ping was refused, when `accepted` is false.
    pub reason: Option<String>,
}
