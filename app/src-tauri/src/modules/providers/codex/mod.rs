//! The Codex provider.
//!
//! Owns the `codex app-server` child process and speaks its protocol. The
//! decoding lives in [`protocol`], the process handling in [`transport`], and
//! this file only composes the two behind the [`Provider`] trait.
//!
//! Credentials are never handled here. The child process inherits the user's
//! existing `codex login` session, so no token ever reaches this process, the
//! renderer, or any file we write.

pub(crate) mod protocol;
pub(crate) mod transport;

use std::sync::Mutex;

use crate::shared::domain::{
    rank_kickoff_models, KickoffModelInfo, PlanKind, ProviderKind, UsageSnapshot,
};
use crate::shared::error::{Error, ErrorKind};
use crate::shared::provider::{PingOutcome, Provider, ProviderStatus};

pub(crate) use transport::probe;
pub(crate) use transport::AppServer;
/// Re-exported so the registry does not reach into this module's internals.
pub use transport::CODEX_EXECUTABLE;

/// Default prompt used to confirm an account can still answer.
///
/// Deliberately trivial and content-free: the point is to prove the window is
/// open, not to make the model do work.
pub const PING_PROMPT: &str = "hi";

/// The read stamp: the clock at the moment a reading is decoded.
///
/// A stamp captured at construction would make a reading fetched hours into a
/// session claim it was fetched at launch, which the freshness label then
/// reports as old on data that is seconds fresh.
fn fresh_now_ms() -> i64 {
    crate::shared::clock::Clock::now_ms(&crate::shared::clock::SystemClock)
}

/// Responses are truncated before crossing IPC.
const MAX_REPLY_CHARS: usize = 280;

/// Upper bound on how long a single ping may take before it is abandoned.
const TURN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

const MODEL_LIST_PAGE_SIZE: u32 = 100;
const MAX_MODEL_LIST_PAGES: usize = 100;

/// Scratch directory the ping thread runs in, so a reply can never touch the
/// user's files even if the sandbox policy is ignored upstream.
///
/// A fixed system location rather than `temp_dir()`, which is not const.
#[cfg(unix)]
const PING_CWD: &str = "/tmp";

#[cfg(windows)]
const PING_CWD: &str = "C:\\Windows\\Temp";

/// The Codex implementation of [`Provider`].
///
/// Holds the app-server lazily so a launch with no Codex installed still gives
/// the UI a usable "not installed" state instead of failing to start.
pub struct CodexProvider {
    server: Mutex<Option<AppServer>>,
    executable: String,
}

impl CodexProvider {
    pub fn new(executable: impl Into<String>) -> Self {
        Self {
            server: Mutex::new(None),
            executable: executable.into(),
        }
    }

    /// Runs `f` against the app-server, starting it on first use.
    ///
    /// The guard is dropped before any caller-supplied work that could await,
    /// so a lock is never held across a blocking boundary.
    fn with_server<T>(&self, f: impl FnOnce(&AppServer) -> Result<T, Error>) -> Result<T, Error> {
        let mut guard = self.server.lock().map_err(|_| {
            Error::new(
                ErrorKind::TransportClosed,
                "The Codex provider is in an unusable state.",
            )
        })?;

        if guard.is_none() {
            *guard = Some(AppServer::spawn(&self.executable)?);
        }

        let server = guard.as_ref().ok_or_else(|| {
            Error::transport_closed("The Codex CLI connection is unavailable.".to_string())
        })?;
        f(server)
    }

    /// Drops the child so the next call starts a fresh one. Used after a turn
    /// leaves the server in a state we would rather not reason about.
    fn reset(&self) {
        if let Ok(mut guard) = self.server.lock() {
            if let Some(server) = guard.take() {
                server.shutdown();
            }
        }
    }

    /// A reading with no network access: what we know from the last successful
    /// poll, or an explicit reason.
    #[cfg(test)]
    fn cached_or_unavailable(&self, reason: impl Into<String>) -> UsageSnapshot {
        UsageSnapshot::unavailable(self.kind(), reason)
    }
}

impl Provider for CodexProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Codex
    }

    fn status(&self) -> ProviderStatus {
        match transport::probe(&self.executable) {
            Ok(version) => ProviderStatus {
                kind: self.kind(),
                executable: self.executable.clone(),
                installed: true,
                version: Some(version),
                reason: None,
            },
            Err(err) => ProviderStatus {
                kind: self.kind(),
                executable: self.executable.clone(),
                installed: false,
                version: None,
                reason: Some(err.message),
            },
        }
    }

    fn read_usage(&self) -> Result<UsageSnapshot, Error> {
        self.with_server(|server| {
            let payload = server.request(
                "account/rateLimits/read",
                // Skip the extra round trip to the reset-credits endpoint: the
                // widget polls on a timer and does not need credit detail.
                Some(serde_json::json!({ "excludeResetCreditDetails": true })),
            )?;
            protocol::decode_rate_limits(&payload, self.kind(), fresh_now_ms())
        })
        .or_else(|err| match err.kind {
            // A signed-out account is a state, not a failure. The client shows
            // the login hint instead of an error banner.
            ErrorKind::ProviderError if is_auth_error(&err.message) => {
                Ok(protocol::decode_signed_out(self.kind()))
            }
            _ => Err(err),
        })
    }

    fn read_account_usage(&self) -> Result<crate::shared::domain::AccountUsage, Error> {
        self.with_server(|server| {
            let payload = server.request("account/usage/read", Some(serde_json::json!({})))?;
            let fetched_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;
            protocol::decode_account_usage(&payload, fetched_at)
        })
    }

    fn account(&self) -> Result<Option<PlanKind>, Error> {
        self.with_server(|server| {
            let payload = server.request("account/read", Some(serde_json::json!({})))?;
            Ok(protocol::decode_account(&payload)?.0)
        })
    }

    fn send_ping(&self, prompt: &str) -> Result<PingOutcome, Error> {
        let model = rank_kickoff_models(self.kind(), self.kickoff_models()?)
            .into_iter()
            .next()
            .ok_or_else(|| Error::provider_error("Codex has no price-listed models available."))?;
        let effort = model
            .lowest_effort()
            .ok_or_else(|| Error::provider_error("Codex reported no supported model effort."))?;
        self.send_kickoff(prompt, &model.id, effort)
    }

    fn kickoff_models(&self) -> Result<Vec<KickoffModelInfo>, Error> {
        self.with_server(|server| {
            let mut models = Vec::new();
            let mut cursor: Option<String> = None;

            for _ in 0..MAX_MODEL_LIST_PAGES {
                let mut params = serde_json::json!({ "limit": MODEL_LIST_PAGE_SIZE });
                if let Some(cursor) = cursor.as_ref() {
                    params["cursor"] = serde_json::Value::String(cursor.clone());
                }
                let payload = server.request("model/list", Some(params))?;
                let page = protocol::decode_model_list_page(&payload)?;
                models.extend(page.models);
                match page.next_cursor {
                    Some(next) if cursor.as_ref() != Some(&next) => cursor = Some(next),
                    Some(_) => {
                        return Err(Error::invalid_payload(
                            "Codex repeated a model-list cursor.",
                        ));
                    }
                    None => return Ok(models),
                }
            }

            Err(Error::invalid_payload(
                "Codex returned too many model-list pages.",
            ))
        })
    }

    fn send_kickoff(&self, prompt: &str, model: &str, effort: &str) -> Result<PingOutcome, Error> {
        let trimmed: String = prompt.chars().take(MAX_REPLY_CHARS).collect();

        let outcome = self.with_server(|server| {
            // A thread that cannot touch the user's files, cannot ask for
            // approval, and is not persisted to disk.
            let mut thread_params = serde_json::json!({
                "cwd": PING_CWD,
                "approvalPolicy": "never",
                "sandbox": "read-only",
                "ephemeral": true,
            });
            thread_params["model"] = serde_json::Value::String(model.to_string());
            let started = server.request("thread/start", Some(thread_params))?;

            let thread_id = parse_nested_id(&started, "thread").ok_or_else(|| {
                Error::invalid_payload("Codex did not return a thread id.".to_string())
            })?;

            let turn = server.request(
                "turn/start",
                Some(serde_json::json!({
                    "threadId": thread_id,
                    "input": [{ "type": "text", "text": trimmed }],
                    "effort": effort,
                })),
            )?;

            // `turn/start` answers immediately with an in-progress turn, so the
            // outcome only ever arrives as a `turn/completed` notification for
            // this id, so it must be matched rather than taking whichever one
            // arrives first.
            let turn_id = parse_nested_id(&turn, "turn").ok_or_else(|| {
                Error::invalid_payload("Codex did not return a turn id.".to_string())
            })?;

            let completed = server.wait_for_turn_completion(&turn_id, TURN_TIMEOUT)?;

            if !protocol::turn_succeeded(&completed)? {
                return Err(Error::provider_error("The Codex turn did not complete."));
            }

            let reply = truncate(&protocol::extract_agent_reply(&completed));

            let usage = match server.request(
                "account/rateLimits/read",
                Some(serde_json::json!({ "excludeResetCreditDetails": true })),
            ) {
                Ok(payload) => {
                    protocol::decode_rate_limits(&payload, self.kind(), fresh_now_ms()).ok()
                }
                // The turn succeeded even if the follow-up read did not.
                Err(_) => None,
            };

            Ok(PingOutcome {
                accepted: true,
                reply,
                usage,
                reason: None,
            })
        });

        // A failed turn often leaves the server mid-conversation; recycle it so
        // the next read starts from a clean handshake.
        if outcome.is_err() {
            self.reset();
        }
        outcome
    }
}

/// Reads `<key>.id` out of a raw response payload.
fn parse_nested_id(payload: &str, key: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(payload)
        .ok()?
        .get(key)?
        .get("id")?
        .as_str()
        .map(ToString::to_string)
}

fn truncate(reply: &str) -> String {
    if reply.chars().count() <= MAX_REPLY_CHARS {
        return reply.to_string();
    }
    let head: String = reply.chars().take(MAX_REPLY_CHARS).collect();
    format!("{head}…")
}

/// Recognises the provider's "you are signed out" errors.
///
/// Matched on message text because the app-server reports these under the
/// generic `-32600` code with no machine-readable discriminator.
fn is_auth_error(message: &str) -> bool {
    let lowered = message.to_ascii_lowercase();
    lowered.contains("authentication required")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_prompt_is_minimal() {
        // Anything larger wastes quota; the window only needs proving open.
        assert_eq!(PING_PROMPT, "hi");
    }

    #[test]
    fn status_reports_a_missing_binary_without_panicking() {
        let provider = CodexProvider::new("definitely-not-a-real-binary-xyz");
        let status = provider.status();
        assert!(!status.installed);
        assert!(status.reason.is_some());
    }

    #[test]
    fn status_reports_the_installed_version() {
        let provider = CodexProvider::new(transport::CODEX_EXECUTABLE);
        let status = provider.status();
        assert!(status.installed, "expected codex on PATH in CI");
        assert!(status.version.unwrap().starts_with("codex-cli"));
    }

    #[test]
    fn reading_without_codex_is_a_typed_error() {
        let provider = CodexProvider::new("definitely-not-a-real-binary-xyz");
        let err = provider.read_usage().expect_err("must fail");
        assert_eq!(err.kind, ErrorKind::ProviderMissing);
    }

    #[test]
    fn recognises_auth_errors() {
        assert!(is_auth_error(
            "codex account authentication required to read rate limits"
        ));
        assert!(is_auth_error(
            "chatgpt authentication required to read rate limits"
        ));
        assert!(!is_auth_error("connection reset"));
    }

    #[test]
    fn reply_is_truncated_to_the_ipc_limit() {
        let long = "a".repeat(1_000);
        let truncated = truncate(&long);
        assert_eq!(truncated.chars().count(), MAX_REPLY_CHARS + 1);
        assert!(truncated.ends_with('…'));
    }

    #[test]
    fn a_short_reply_is_untouched() {
        assert_eq!(truncate("hello"), "hello");
    }

    #[test]
    fn an_unavailable_snapshot_names_the_executable() {
        let provider = CodexProvider::new("definitely-not-a-real-binary-xyz");
        let snapshot = provider.cached_or_unavailable("not installed");
        assert_eq!(snapshot.provider, ProviderKind::Codex);
        assert_eq!(snapshot.reason.as_deref(), Some("not installed"));
    }
}
