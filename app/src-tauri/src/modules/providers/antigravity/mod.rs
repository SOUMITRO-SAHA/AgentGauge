//! The Antigravity CLI integration.
//!
//! Antigravity (`agy`, Google's terminal coding agent) exposes quota through
//! its own `/usage` command, which this provider runs headless in JSON mode
//! — an internal slash command that costs no quota and never starts a
//! session. Token analytics are a different matter: the CLI records no
//! token counts locally, so the account read is the machine's own session
//! record, and every capability that could spend quota (ping, kickoff)
//! refuses outright.

pub(crate) mod sessions;
pub(crate) mod usage;

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

    /// The quota windows come from the CLI's own `/usage` command, run
    /// headless with JSON output: an internal slash command, so the read
    /// costs no quota. Failures degrade to an explicit unavailable state.
    fn read_usage(&self) -> Result<UsageSnapshot, Error> {
        usage::read_usage_snapshot(ProviderKind::Antigravity, Clock::now_ms(&SystemClock))
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
    fn a_missing_cli_degrades_to_an_explicit_unavailable_reading() {
        let _env = crate::shared::executable::test_env_lock();
        struct OverrideGuard {
            key: &'static str,
            previous: Option<std::ffi::OsString>,
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

        let key = ANTIGRAVITY_PATH_OVERRIDE;
        let guard = OverrideGuard {
            key,
            previous: std::env::var_os(key),
        };
        std::env::set_var(key, "/nonexistent/antigravity-usage-test/agy");
        let snapshot = AntigravityProvider::new().read_usage();
        drop(guard);

        let snapshot = snapshot.expect("snapshot");
        assert_eq!(snapshot.provider, ProviderKind::Antigravity);
        assert_eq!(
            snapshot.freshness,
            crate::shared::domain::Freshness::Unavailable
        );
        assert!(snapshot.windows.is_empty());
        assert!(snapshot
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains(ANTIGRAVITY_PATH_OVERRIDE)));
    }

    #[cfg(unix)]
    #[test]
    fn the_usage_read_parses_the_cli_json_envelope() {
        use std::os::unix::fs::PermissionsExt;

        let _env = crate::shared::executable::test_env_lock();
        struct OverrideGuard {
            key: &'static str,
            previous: Option<std::ffi::OsString>,
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
            .join("../../.temp/antigravity-usage-tests")
            .join(format!("read-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create fixture directory");
        let reply = directory.join("reply.json");
        std::fs::write(&reply, usage::test_fixture_reply()).expect("write fixture reply");
        let path = directory.join("agy");
        std::fs::write(
            &path,
            format!("#!/bin/sh\ncat \"{}\"\n", reply.to_string_lossy()),
        )
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
        let snapshot = AntigravityProvider::new().read_usage();
        drop(guard);
        let _ = std::fs::remove_dir_all(directory);

        let snapshot = snapshot.expect("snapshot");
        assert_eq!(snapshot.freshness, crate::shared::domain::Freshness::Live);
        assert_eq!(snapshot.windows.len(), 4);
        let gemini_weekly = &snapshot.windows[0];
        assert_eq!(gemini_weekly.label, "Gemini weekly");
        assert_eq!(gemini_weekly.remaining_percent, 75);
        assert_eq!(gemini_weekly.used_percent, 25);
        assert!(gemini_weekly.resets_at.is_some());
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
