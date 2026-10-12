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

mod db;

pub(crate) use db::local_usage_for;

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

/// How many extra reads to make when OpenCode answers with an empty list.
///
/// Verified against OpenCode's source: the daemon answers `/api/provider`
/// with HTTP 200 and an empty set while a location's services are still
/// booting — catalog reads are not gated on the forked boot fiber and the
/// initial catalog state is empty. An empty answer on a cold daemon therefore
/// means "not warm yet", not "nothing is connected", and settling on it would
/// hide connected plans until a manual refresh. The retries are bounded, and
/// a warm daemon answers in well under a second, so a user with genuinely
/// nothing connected pays at most a few seconds once.
const EMPTY_LIST_RETRIES: usize = 4;

/// Pause between empty-list retries, chosen to span the daemon's boot.
const EMPTY_RETRY_PAUSE: Duration = Duration::from_millis(750);

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

#[derive(Debug, Clone, PartialEq, Eq)]
/// A model identifier reported by the OpenCode CLI.
pub struct OpenCodeModel {
    pub provider_id: String,
    pub model_id: String,
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
        Self::read_via(|args| run_capture(args, CLI_TIMEOUT))
    }

    /// Same read, over an injectable fetch, so the empty-answer retry rule is
    /// testable without spawning the CLI.
    fn read_via<T>(fetch: T) -> Result<Self, Error>
    where
        T: FnMut(&[&str]) -> Result<String, Error>,
    {
        Self::read_with_retry_pause(fetch, EMPTY_RETRY_PAUSE)
    }

    /// The same read with an explicit retry pause, so tests exercise the
    /// retry rule without waiting out real boot pauses.
    fn read_with_retry_pause<T>(mut fetch: T, pause: Duration) -> Result<Self, Error>
    where
        T: FnMut(&[&str]) -> Result<String, Error>,
    {
        let listing = read_listing_with_retry(&mut fetch, pause)?;
        let entries: Vec<ExportEntry> = decode(&fetch(&["auth", "export"])?)?;
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

/// Decodes CLI stdout as JSON.
fn decode<T: serde::de::DeserializeOwned>(stdout: &str) -> Result<T, Error> {
    serde_json::from_str(stdout).map_err(|error| {
        Error::new(
            ErrorKind::InvalidPayload,
            format!("OpenCode replied with a payload this app could not read ({error})."),
        )
    })
}

/// Reads the connected-provider listing, retrying an empty answer.
///
/// The invocation pins `location[directory]` to the user's home: OpenCode's
/// default location is the daemon's own spawn directory, which is arbitrary
/// from this app's perspective. The raw `get /api/provider` path is used
/// because the operation-id spelling changed between OpenCode releases while
/// the route itself did not.
fn read_listing_with_retry<T>(fetch: T, pause: Duration) -> Result<ListingResponse, Error>
where
    T: FnMut(&[&str]) -> Result<String, Error>,
{
    let mut fetch = fetch;
    let args = listing_args();
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut attempts = 0;
    loop {
        attempts += 1;
        let listing: ListingResponse = decode(&fetch(&arg_refs)?)?;
        if !listing.data.is_empty() || attempts > EMPTY_LIST_RETRIES {
            return Ok(listing);
        }
        std::thread::sleep(pause);
    }
}

/// The CLI arguments for the provider listing, with the home directory
/// pinned as the location when the platform exposes one.
fn listing_args() -> Vec<String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();
    let mut args = vec![
        "api".to_string(),
        "get".to_string(),
        "/api/provider".to_string(),
    ];
    if let Some(home) = home {
        args.push("--param".to_string());
        args.push(format!("location[directory]={home}"));
    }
    args
}

/// Reads the model ids OpenCode currently exposes to configured providers.
pub fn available_models() -> Result<Vec<OpenCodeModel>, Error> {
    let output = run_capture(&["models"], CLI_TIMEOUT)?;
    Ok(parse_model_listing(&output))
}

fn parse_model_listing(output: &str) -> Vec<OpenCodeModel> {
    output
        .lines()
        .filter_map(|line| {
            let (provider_id, model_id) = line.trim().split_once('/')?;
            if provider_id.is_empty()
                || model_id.is_empty()
                || provider_id.chars().any(char::is_whitespace)
                || model_id.chars().any(char::is_whitespace)
            {
                return None;
            }
            Some(OpenCodeModel {
                provider_id: provider_id.to_string(),
                model_id: model_id.to_string(),
            })
        })
        .collect()
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

    #[test]
    fn a_cold_daemons_empty_answer_is_retried_until_it_is_not() {
        // OpenCode answers 200 with an empty set while a location boots; the
        // second read must win or connected plans stay hidden.
        let mut calls = 0;
        let catalog = OpenCodeCatalog::read_with_retry_pause(
            |args| {
                if args[0] != "api" {
                    return Ok("[]".to_string());
                }
                calls += 1;
                if calls == 1 {
                    Ok(r#"{"data":[]}"#.to_string())
                } else {
                    Ok(LISTING.to_string())
                }
            },
            Duration::ZERO,
        )
        .expect("reads");
        assert_eq!(calls, 2);
        assert!(catalog
            .subscriptions()
            .iter()
            .any(|sub| sub.provider_id == "zai-coding-plan"));
    }

    #[test]
    fn an_empty_answer_settles_after_bounded_retries() {
        // A user with nothing connected must not spin forever.
        let mut calls = 0;
        let catalog = OpenCodeCatalog::read_with_retry_pause(
            |args| {
                if args[0] != "api" {
                    return Ok("[]".to_string());
                }
                calls += 1;
                Ok(r#"{"data":[]}"#.to_string())
            },
            Duration::ZERO,
        )
        .expect("reads");
        assert_eq!(calls, EMPTY_LIST_RETRIES + 1);
        assert!(catalog.subscriptions().is_empty());
    }

    #[test]
    fn parses_models_only_from_the_harness_provider_model_lines() {
        let models = parse_model_listing(
            "openai/gpt-6-luna\nzai-coding-plan/glm-5.3-flash\nModels available:\n",
        );

        assert_eq!(
            models,
            vec![
                OpenCodeModel {
                    provider_id: "openai".into(),
                    model_id: "gpt-6-luna".into(),
                },
                OpenCodeModel {
                    provider_id: "zai-coding-plan".into(),
                    model_id: "glm-5.3-flash".into(),
                },
            ]
        );
    }

    #[test]
    fn the_listing_pins_the_home_location_and_raw_route() {
        let args = listing_args();
        assert!(args.contains(&"/api/provider".to_string()));
        let pinned = args
            .windows(2)
            .any(|pair| pair[0] == "--param" && pair[1].starts_with("location[directory]="));
        assert!(pinned, "location must be pinned, got {args:?}");
    }
}
