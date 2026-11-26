//! The Antigravity CLI integration.
//!
//! Antigravity (`agy`, Google's terminal coding agent) publishes no interface
//! AgentGauge can read quota through: its `/usage` command talks to an
//! internal Google API with credentials that never leave the OS keyring, and
//! its local files record sessions, not tokens. What this provider offers is
//! therefore honest by construction — an installation check, and the session
//! record `sessions.rs` reads — and every capability it cannot provide
//! refuses instead of fabricating.

pub(crate) mod sessions;

use crate::shared::clock::{Clock, SystemClock};
use crate::shared::domain::{
    AccountUsage, AccountUsageSummary, KickoffModelInfo, PlanKind, ProviderKind, UsageSnapshot,
};
use crate::shared::error::Error;
use crate::shared::provider::{PingOutcome, Provider, ProviderStatus};

use super::codex;
use super::coding_plan;

/// Antigravity's executable, as installed by its official installer.
pub(crate) const ANTIGRAVITY_EXECUTABLE: &str = "agy";
const ANTIGRAVITY_PATH_OVERRIDE: &str = "AGENTGAUGE_ANTIGRAVITY_PATH";
const ANTIGRAVITY_DISPLAY_NAME: &str = "Antigravity CLI";

pub struct AntigravityProvider;

impl AntigravityProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for AntigravityProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for AntigravityProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Antigravity
    }

    fn status(&self) -> ProviderStatus {
        match codex::probe(
            ANTIGRAVITY_EXECUTABLE,
            ANTIGRAVITY_PATH_OVERRIDE,
            ANTIGRAVITY_DISPLAY_NAME,
        ) {
            Ok(version) => ProviderStatus {
                kind: ProviderKind::Antigravity,
                executable: ANTIGRAVITY_EXECUTABLE.to_string(),
                installed: true,
                version: Some(version),
                reason: None,
            },
            Err(error) => ProviderStatus {
                kind: ProviderKind::Antigravity,
                executable: ANTIGRAVITY_EXECUTABLE.to_string(),
                installed: false,
                version: None,
                reason: Some(error.message),
            },
        }
    }

    fn read_usage(&self) -> Result<UsageSnapshot, Error> {
        Ok(UsageSnapshot::unavailable(
            ProviderKind::Antigravity,
            "Antigravity reports quota only inside its own /usage command; \
             it has no interface AgentGauge can read.",
        ))
    }

    /// The account read is the machine's own Antigravity session record.
    /// With no record at all this stays the "unsupported" answer rather than
    /// an empty panel, matching how the local-only coding plans behave.
    fn read_account_usage(&self) -> Result<AccountUsage, Error> {
        let Some(home) = sessions::gemini_home() else {
            return Err(coding_plan::unsupported(
                ProviderKind::Antigravity,
                "account activity",
            ));
        };
        sessions::read_sessions(&home)
            .map(|local| AccountUsage {
                fetched_at: Clock::now_ms(&SystemClock),
                summary: AccountUsageSummary::default(),
                daily_usage_buckets: Vec::new(),
                models: Vec::new(),
                model_daily_usage: Vec::new(),
                cache_stats: None,
                local: Some(local),
                window_days: None,
            })
            .ok_or_else(|| coding_plan::unsupported(ProviderKind::Antigravity, "account activity"))
    }

    fn account(&self) -> Result<Option<PlanKind>, Error> {
        Ok(None)
    }

    fn send_ping(&self, _prompt: &str) -> Result<PingOutcome, Error> {
        Err(coding_plan::unsupported(
            ProviderKind::Antigravity,
            "a ping",
        ))
    }

    fn kickoff_models(&self) -> Result<Vec<KickoffModelInfo>, Error> {
        Err(coding_plan::unsupported(
            ProviderKind::Antigravity,
            "kickoff models",
        ))
    }

    fn send_kickoff(
        &self,
        _prompt: &str,
        _model: &str,
        _effort: &str,
    ) -> Result<PingOutcome, Error> {
        Err(coding_plan::unsupported(
            ProviderKind::Antigravity,
            "a kickoff",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_provider_speaks_for_antigravity() {
        let provider = AntigravityProvider::new();
        assert_eq!(provider.kind(), ProviderKind::Antigravity);
        assert_eq!(provider.kind().as_str(), "antigravity");
        assert_eq!(provider.kind().display_name(), "Antigravity");
        assert_eq!(provider.status().kind, ProviderKind::Antigravity);
        assert_eq!(provider.status().executable, "agy");
    }

    #[test]
    fn the_usage_read_reports_why_there_are_no_windows() {
        let snapshot = AntigravityProvider::new().read_usage().expect("snapshot");
        assert_eq!(snapshot.provider, ProviderKind::Antigravity);
        assert_eq!(
            snapshot.freshness,
            crate::shared::domain::Freshness::Unavailable
        );
        assert!(snapshot.windows.is_empty());
        assert!(snapshot
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("/usage")));
    }

    #[test]
    fn antigravity_refuses_every_quota_spending_capability() {
        let provider = AntigravityProvider::new();
        assert!(provider.send_ping("hi").is_err());
        assert!(provider.kickoff_models().is_err());
        assert!(provider.send_kickoff("hi", "model", "low").is_err());
        assert!(provider.account().is_ok_and(|plan| plan.is_none()));
    }

    #[test]
    fn the_local_read_refuses_when_no_record_exists() {
        // Like the local-only coding plans, Antigravity's session record
        // flows through the account read, so the trait default stays empty.
        assert_eq!(
            Provider::read_local_usage(&AntigravityProvider::new()),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn status_uses_the_antigravity_executable_override() {
        use std::ffi::OsString;
        use std::os::unix::fs::PermissionsExt;

        let _env = crate::shared::executable::test_env_lock();
        struct OverrideGuard {
            key: &'static str,
            previous: Option<OsString>,
        }

        impl Drop for OverrideGuard {
            fn drop(&mut self) {
                if let Some(value) = self.previous.take() {
                    std::env::set_var(self.key, value);
                } else {
                    std::env::remove_var(self.key);
                }
            }
        }

        let directory = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.temp/antigravity-status-tests")
            .join(format!("override-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create fixture directory");
        let path = directory.join("agy");
        std::fs::write(&path, "#!/bin/sh\nprintf 'agy-override-fixture\\n'\n")
            .expect("write fixture executable");
        let mut permissions = std::fs::metadata(&path)
            .expect("read fixture permissions")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).expect("make fixture executable");

        let key = ANTIGRAVITY_PATH_OVERRIDE;
        let guard = OverrideGuard {
            key,
            previous: std::env::var_os(key),
        };
        std::env::set_var(key, &path);
        let status = AntigravityProvider::new().status();
        drop(guard);
        let _ = std::fs::remove_dir_all(directory);

        assert!(status.installed);
        assert_eq!(status.version.as_deref(), Some("agy-override-fixture"));
        assert!(!status.installed || status.reason.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_status_check_does_not_leak_the_executable_path() {
        use std::ffi::OsString;
        use std::os::unix::fs::PermissionsExt;

        let _env = crate::shared::executable::test_env_lock();
        struct OverrideGuard {
            key: &'static str,
            previous: Option<OsString>,
        }

        impl Drop for OverrideGuard {
            fn drop(&mut self) {
                if let Some(value) = self.previous.take() {
                    std::env::set_var(self.key, value);
                } else {
                    std::env::remove_var(self.key);
                }
            }
        }

        let directory = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.temp/antigravity-status-tests")
            .join(format!("failing-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create fixture directory");
        let path = directory.join("agy");
        std::fs::write(&path, "#!/bin/sh\nexit 3\n").expect("write fixture executable");
        let mut permissions = std::fs::metadata(&path)
            .expect("read fixture permissions")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).expect("make fixture executable");

        let key = ANTIGRAVITY_PATH_OVERRIDE;
        let guard = OverrideGuard {
            key,
            previous: std::env::var_os(key),
        };
        std::env::set_var(key, &path);
        let status = AntigravityProvider::new().status();
        drop(guard);
        let leaked = status
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains(&path.to_string_lossy().into_owned()));
        let _ = std::fs::remove_dir_all(directory);

        assert!(!status.installed);
        assert!(
            !leaked,
            "the failure reason must not name the executable path"
        );
    }

    /// Prints what the app would show for this machine's Antigravity install.
    /// Ignored by default like the other live probes; run it with
    /// `cargo test --features testkit --lib antigravity -- --ignored`.
    #[test]
    #[ignore]
    fn live_antigravity_read_prints_what_the_app_would_see() {
        let provider = AntigravityProvider::new();
        println!("status: {:?}", provider.status());
        println!("usage: {:?}", provider.read_usage());
        match provider.read_account_usage() {
            Ok(usage) => println!("account local: {:#?}", usage.local),
            Err(error) => println!("account read refused: {error}"),
        }
    }
}
