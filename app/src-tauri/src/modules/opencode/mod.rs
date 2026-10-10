//! The OpenCode integration: what the user connected, through OpenCode itself.
//!
//! Every fact here comes from invoking the `opencode` CLI — the same interface
//! a human uses — so this app never opens OpenCode's database, never stores or
//! writes a credential, and never has to track OpenCode's storage format.
//!
//! Two read-only calls carry everything:
//!
//! * `opencode api provider.list` — the connected providers, straight from the
//!   running OpenCode service. This is the set OpenCode itself reports as
//!   available (stored credential, live environment variable, or config).
//! * `opencode auth export` — OpenCode's own migration export, used only to
//!   learn whether a credential is stored and to hand a key to the vendor's
//!   documented quota endpoint. The key never leaves this process except in
//!   that one request, and is never logged, persisted, or sent over IPC.
//!
//! If OpenCode is not installed, every call fails with `ProviderMissing` and
//! the UI says so — Codex usage is unaffected.

use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde::Deserialize;

use crate::shared::domain::{CodingSubscription, CredentialOrigin, ProviderKind};
use crate::shared::error::{Error, ErrorKind};

/// How long any single `opencode` CLI call may run before it is killed.
///
/// A cold service start can take a few seconds; a hung CLI must never hang a
/// usage read with it.
const CLI_TIMEOUT: Duration = Duration::from_secs(15);

/// The executable resolved the same way the Codex provider resolves `codex`.
pub const OPENCODE_EXECUTABLE: &str = "opencode";

/// Everything `subscriptions()` and the providers need, decoded from the two
/// CLI payloads. Kept separate from the spawning so the decoding is testable
/// against recorded payloads without invoking anything.
pub struct OpenCodeCatalog {
    /// The provider ids OpenCode reports as available, in reported order.
    connected: Vec<String>,
    /// Display names and API bases from the same listing.
    details: Vec<ProviderListing>,
    /// OpenCode's credential export, kept only to answer "is it stored" and
    /// "what key does the vendor's quota endpoint need". Never serialized.
    entries: Vec<ExportEntry>,
}

#[derive(Debug, Clone, Deserialize)]
struct ProviderListing {
    id: String,
    name: String,
    #[serde(default)]
    #[serde(rename = "activation")]
    _activation: String,
    #[serde(default)]
    settings: ListingSettings,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ListingSettings {
    #[serde(rename = "baseURL", default)]
    base_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ListingResponse {
    #[serde(default)]
    data: Vec<ProviderListing>,
}

#[derive(Debug, Deserialize)]
struct ExportEntry {
    #[serde(rename = "integrationID")]
    integration_id: String,
    value: ExportValue,
}

#[derive(Debug, Deserialize)]
struct ExportValue {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    key: Option<String>,
}

impl OpenCodeCatalog {
    /// Reads both payloads. The export call is what carries secrets, so its
    /// failure paths are indistinguishable from "no file" on purpose.
    pub fn read() -> Result<Self, Error> {
        let listing = run_json::<ListingResponse>(&["api", "provider.list"])?;
        let entries = run_json::<Vec<ExportEntry>>(&["auth", "export"])?;
        Ok(Self {
            connected: listing.data.iter().map(|item| item.id.clone()).collect(),
            details: listing.data,
            entries,
        })
    }

    /// The connected coding subscriptions, in the order OpenCode listed them.
    ///
    /// A subscription is whatever the provider catalog itself names as a plan —
    /// the `-coding-plan` / `-token-plan` / `-code-plan` / `-tokenhub` ids and
    /// Kimi's `kimi-for-coding`. Everything else (pay-as-you-go API keys,
    /// gateways) is deliberately excluded: it is not a subscription.
    pub fn subscriptions(&self) -> Vec<CodingSubscription> {
        self.details
            .iter()
            .filter(|item| is_coding_plan(&item.id))
            .map(|item| {
                let integration = integration_for(&item.id);
                CodingSubscription {
                    label: integration
                        .map(ProviderKind::display_name)
                        .unwrap_or(item.name.as_str())
                        .to_string(),
                    credential: if self.is_stored(&item.id) {
                        CredentialOrigin::Stored
                    } else {
                        CredentialOrigin::Unknown
                    },
                    integration,
                    provider_id: item.id.clone(),
                    name: item.name.clone(),
                    api_base: item.settings.base_url.clone(),
                }
            })
            .collect()
    }

    fn is_stored(&self, provider_id: &str) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.integration_id == provider_id)
    }

    /// Whether OpenCode reports this provider id as available.
    pub fn is_connected(&self, provider_id: &str) -> bool {
        self.connected.iter().any(|id| id == provider_id)
    }

    /// The stored API key for a plan, when OpenCode holds a usable one.
    ///
    /// `Ok(None)` covers every honest "cannot" at once: nothing stored, an
    /// OAuth credential this app cannot refresh, or a plan the user connected
    /// by environment variable — which lives in OpenCode's process, not here.
    pub fn api_key(&self, provider_id: &str) -> Result<Option<String>, Error> {
        if !self.connected.iter().any(|id| id == provider_id) {
            return Ok(None);
        }
        Ok(self
            .entries
            .iter()
            .find(|entry| entry.integration_id == provider_id && entry.value.kind == "key")
            .and_then(|entry| entry.value.key.clone()))
    }
}

/// Runs the CLI and decodes stdout as JSON, on a deadline.
///
/// The child is killed on timeout rather than left to block a usage read; the
/// error then says the tool hung instead of pretending there was no data.
fn run_json<T: serde::de::DeserializeOwned>(args: &[&str]) -> Result<T, Error> {
    let stdout = run_capture(args, CLI_TIMEOUT)?;
    serde_json::from_str(&stdout).map_err(|error| {
        Error::new(
            ErrorKind::InvalidPayload,
            format!("OpenCode replied with a payload this app could not read ({error})."),
        )
    })
}

fn run_capture(args: &[&str], timeout: Duration) -> Result<String, Error> {
    let mut child = Command::new(OPENCODE_EXECUTABLE)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            Error::new(
                ErrorKind::ProviderMissing,
                format!("The `opencode` executable was not found on PATH ({error})."),
            )
        })?;

    let (tx, rx) = mpsc::channel();
    let handle = child.stdout.take();
    let err_handle = child.stderr.take();
    std::thread::spawn(move || {
        let output = capture_both(handle, err_handle);
        let _ = tx.send(output);
    });

    match rx.recv_timeout(timeout) {
        Ok(Ok((stdout, _stderr))) => {
            let _ = child.wait();
            Ok(stdout)
        }
        Ok(Err(detail)) => Err(Error::new(
            ErrorKind::ProviderError,
            format!("OpenCode replied with an error: {detail}"),
        )),
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(Error::timeout(
                "OpenCode did not answer in time. Try again in a moment.",
            ))
        }
    }
}

fn capture_both(
    stdout: Option<std::process::ChildStdout>,
    stderr: Option<std::process::ChildStderr>,
) -> Result<(String, String), String> {
    use std::io::Read;
    fn read_pipe(mut pipe: Option<impl Read>) -> String {
        pipe.take()
            .map(|mut stream| {
                let mut buffer = String::new();
                stream
                    .read_to_string(&mut buffer)
                    .map(|_| buffer)
                    .unwrap_or_default()
            })
            .unwrap_or_default()
    }
    let out = read_pipe(stdout);
    let err = read_pipe(stderr);
    if out.trim().is_empty() {
        Err(err.lines().last().unwrap_or("no output").to_string())
    } else {
        Ok((out, err))
    }
}

/// Whether a provider id names a subscription plan rather than pay-as-you-go
/// API access.
///
/// The catalog encodes plan-ness in the id itself — there is no plan field
/// anywhere in models.dev — so the suffixes are the contract.
pub fn is_coding_plan(provider_id: &str) -> bool {
    provider_id == "kimi-for-coding"
        || provider_id.starts_with("kimi-code-plan")
        || provider_id.ends_with("-coding-plan")
        || provider_id.ends_with("-token-plan")
        || provider_id.ends_with("-code-plan")
        || provider_id.ends_with("-tokenhub")
}

/// The usage-reading integration for a plan id, when this build has one.
pub fn integration_for(provider_id: &str) -> Option<ProviderKind> {
    match provider_id {
        "zai-coding-plan" | "zhipuai-coding-plan" => Some(ProviderKind::Zai),
        "minimax-coding-plan" | "minimax-cn-coding-plan" => Some(ProviderKind::Minimax),
        "kimi-for-coding" | "kimi-code-plan-cn" | "kimi-code-plan-global" => {
            Some(ProviderKind::Kimi)
        }
        _ => None,
    }
}

/// The quota-endpoint host for a plan id.
///
/// One vendor, two regions, two hosts: the global and China plans are separate
/// catalog entries with separate keys, and the key only works against its own
/// region's host.
pub fn quota_host(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        "zai-coding-plan" => Some("https://api.z.ai"),
        "zhipuai-coding-plan" => Some("https://open.bigmodel.cn"),
        "minimax-coding-plan" => Some("https://api.minimax.io"),
        "minimax-cn-coding-plan" => Some("https://api.minimaxi.com"),
        "kimi-for-coding" | "kimi-code-plan-cn" => Some("https://api.kimi.com"),
        "kimi-code-plan-global" => Some("https://api.kimi.ai"),
        _ => None,
    }
}

/// Builds a catalog from recorded payloads, for tests of everything that
/// consumes OpenCode without spawning the CLI.
#[cfg(test)]
pub(crate) fn fixture_catalog(listing_json: &str, export_json: &str) -> OpenCodeCatalog {
    let listing: ListingResponse = serde_json::from_str(listing_json).expect("listing decodes");
    let entries: Vec<ExportEntry> = serde_json::from_str(export_json).expect("export decodes");
    OpenCodeCatalog {
        connected: listing.data.iter().map(|item| item.id.clone()).collect(),
        details: listing.data,
        entries,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LISTING: &str = r#"{
        "location": {"directory": "/tmp"},
        "data": [
            {"id": "google", "name": "Google", "activation": "auto"},
            {"id": "zai-coding-plan", "name": "Z.AI Coding Plan", "activation": "auto",
             "settings": {"baseURL": "https://api.z.ai/api/coding/paas/v4"}},
            {"id": "minimax-coding-plan", "name": "MiniMax Token Plan (minimax.io)", "activation": "auto"},
            {"id": "alibaba-coding-plan", "name": "Alibaba Coding Plan", "activation": "auto"},
            {"id": "deepseek", "name": "DeepSeek", "activation": "auto"}
        ]
    }"#;

    fn catalog() -> OpenCodeCatalog {
        OpenCodeCatalog {
            connected: vec![
                "google".into(),
                "zai-coding-plan".into(),
                "minimax-coding-plan".into(),
                "alibaba-coding-plan".into(),
                "deepseek".into(),
            ],
            details: serde_json::from_str::<ListingResponse>(LISTING)
                .expect("listing decodes")
                .data,
            entries: vec![ExportEntry {
                integration_id: "zai-coding-plan".into(),
                value: ExportValue {
                    kind: "key".into(),
                    key: Some("redacted".into()),
                },
            }],
        }
    }

    #[test]
    #[ignore = "live probe: runs the real `opencode` CLI on this machine"]
    fn live_catalog_read_prints_what_the_app_would_see() {
        match OpenCodeCatalog::read() {
            Ok(catalog) => {
                for subscription in catalog.subscriptions() {
                    println!(
                        "LIVE_SUB>>> {} -> {:?} ({:?})",
                        subscription.provider_id, subscription.integration, subscription.credential
                    );
                }
            }
            Err(error) => println!("LIVE_ERR>>> kind={:?} msg={}", error.kind, error.message),
        }
    }

    #[test]
    fn only_subscription_plans_are_listed() {
        let subscriptions = catalog().subscriptions();
        let ids: Vec<&str> = subscriptions
            .iter()
            .map(|sub| sub.provider_id.as_str())
            .collect();
        assert_eq!(
            ids,
            [
                "zai-coding-plan",
                "minimax-coding-plan",
                "alibaba-coding-plan"
            ]
        );
    }

    #[test]
    fn a_plan_without_an_integration_still_lists() {
        // Connected is connected: the tab renders an honest "no reading yet"
        // rather than hiding a subscription the user pays for.
        let alibaba = catalog()
            .subscriptions()
            .into_iter()
            .find(|sub| sub.provider_id == "alibaba-coding-plan")
            .expect("listed");
        assert_eq!(alibaba.integration, None);
        assert_eq!(alibaba.label, "Alibaba Coding Plan");
    }

    #[test]
    fn a_known_plan_carries_its_short_label_and_integration() {
        let zai = catalog()
            .subscriptions()
            .into_iter()
            .find(|sub| sub.provider_id == "zai-coding-plan")
            .expect("listed");
        assert_eq!(zai.integration, Some(ProviderKind::Zai));
        assert_eq!(zai.label, "Z.AI");
        assert_eq!(zai.credential, CredentialOrigin::Stored);
        assert_eq!(
            zai.api_base.as_deref(),
            Some("https://api.z.ai/api/coding/paas/v4")
        );
    }

    #[test]
    fn kimi_for_coding_is_a_plan_without_the_suffix() {
        assert!(is_coding_plan("kimi-for-coding"));
        assert!(is_coding_plan("kimi-code-plan-global"));
        assert!(is_coding_plan("tencent-tokenhub"));
        assert!(!is_coding_plan("deepseek"));
        assert!(!is_coding_plan("zai"));
        assert!(!is_coding_plan("anthropic"));
    }

    #[test]
    fn every_integration_has_a_quota_host() {
        for id in [
            "zai-coding-plan",
            "zhipuai-coding-plan",
            "minimax-coding-plan",
            "minimax-cn-coding-plan",
            "kimi-for-coding",
            "kimi-code-plan-cn",
            "kimi-code-plan-global",
        ] {
            assert!(quota_host(id).is_some(), "{id} lost its host");
        }
    }

    #[test]
    fn every_integration_id_maps_to_a_kind_and_back() {
        // The mapping is the single place a plan id becomes an integration;
        // if it claims an integration, that integration must exist in this
        // build's ProviderKind.
        assert_eq!(integration_for("zai-coding-plan"), Some(ProviderKind::Zai));
        assert_eq!(
            integration_for("minimax-cn-coding-plan"),
            Some(ProviderKind::Minimax)
        );
        assert_eq!(
            integration_for("kimi-code-plan-global"),
            Some(ProviderKind::Kimi)
        );
        assert_eq!(integration_for("openai"), None);
    }

    #[test]
    fn a_stored_key_is_returned_only_for_a_connected_key_credential() {
        let catalog = catalog();
        assert_eq!(
            catalog.api_key("zai-coding-plan").expect("reads"),
            Some("redacted".to_string())
        );
        assert_eq!(catalog.api_key("deepseek").expect("reads"), None);
        assert_eq!(catalog.api_key("not-connected").expect("reads"), None);
    }

    #[test]
    fn an_oauth_credential_is_not_a_usable_key() {
        // OAuth plans need a refresh this app must not attempt, so the honest
        // answer is "no usable key" rather than a failing request.
        let mut catalog = catalog();
        catalog.entries[0].value.kind = "oauth".into();
        catalog.entries[0].value.key = None;
        assert_eq!(catalog.api_key("zai-coding-plan").expect("reads"), None);
    }
}
