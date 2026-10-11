//! The shared read pipeline for OpenCode-managed coding plans.
//!
//! Every plan provider answers the same three questions in the same order —
//! is OpenCode reachable, is this plan connected, does OpenCode hold a usable
//! key — and only then talks to the vendor's quota endpoint. The steps live
//! here so each provider module is nothing but its spec and its decoder.

use crate::modules::opencode::{self, quota_host, OpenCodeCatalog, OPENCODE_EXECUTABLE};
use crate::modules::providers::http::{self, AuthHeader};
use crate::shared::domain::{
    kickoff_model_label, AccountUsage, KickoffEffortInfo, KickoffModelInfo, ProviderKind,
    UsageSnapshot,
};
use crate::shared::error::{Error, ErrorKind};
use crate::shared::provider::{PingOutcome, ProviderStatus};

/// What one provider reads and how.
#[derive(Clone, Copy)]
pub(crate) struct PlanSpec {
    pub kind: ProviderKind,
    /// The catalog plan ids this integration reads, most preferred first.
    pub family: &'static [&'static str],
    /// The quota path appended to the plan's region host.
    pub path: &'static str,
    /// Whether the endpoint takes a bearer credential; Z.AI's takes the raw
    /// key, the others take the usual bearer form.
    pub bearer: bool,
}

/// One decided step of a plan read.
///
/// The decision half of the pipeline, separated from the network half so it is
/// testable without spawning OpenCode or touching a vendor. The credential, if
/// any, exists only inside this value for the length of the call.
pub(crate) enum PlanRequest {
    /// Nothing to fetch; the snapshot says why.
    Unavailable(UsageSnapshot),
    /// A quota read to make against the vendor.
    Fetch { url: String, auth: AuthHeader },
}

/// Decides what a plan read needs, without doing it.
///
/// The path is a parameter rather than a spec field so one provider can read
/// several endpoints — including one whose query string is built at runtime —
/// through the same decision.
pub(crate) fn plan_request(catalog: &OpenCodeCatalog, spec: &PlanSpec, path: &str) -> PlanRequest {
    let Some(provider_id) = spec
        .family
        .iter()
        .find(|id| catalog.is_connected(id))
        .copied()
    else {
        return PlanRequest::Unavailable(UsageSnapshot::unavailable(
            spec.kind,
            format!(
                "The {} coding plan is not connected in OpenCode.",
                spec.kind.display_name()
            ),
        ));
    };

    let key = match catalog.api_key(provider_id) {
        Ok(Some(key)) => key,
        Ok(None) => {
            return PlanRequest::Unavailable(UsageSnapshot::unavailable(
                spec.kind,
                format!(
                    "OpenCode holds no readable {} credential; an OAuth or environment key cannot be used here.",
                    spec.kind.display_name()
                ),
            ));
        }
        Err(error) => {
            return PlanRequest::Unavailable(UsageSnapshot::unavailable(
                spec.kind,
                format!(
                    "OpenCode's credential store could not be read: {}",
                    error.message
                ),
            ));
        }
    };

    let Some(host) = quota_host(provider_id) else {
        return PlanRequest::Unavailable(UsageSnapshot::unavailable(
            spec.kind,
            format!("No usage endpoint is known for `{provider_id}`."),
        ));
    };

    PlanRequest::Fetch {
        url: format!("{host}{path}"),
        auth: if spec.bearer {
            AuthHeader::Bearer(key)
        } else {
            AuthHeader::Raw(key)
        },
    }
}

/// Reads a plan's usage end to end.
///
/// "No data" outcomes — OpenCode missing, plan not connected, no usable key —
/// are returned as `Unavailable` snapshots so the UI renders a state, matching
/// the provider trait's contract. Only a fetch or decode that actually failed
/// is an `Err`.
pub(crate) fn read_usage(
    spec: &PlanSpec,
    decode: impl Fn(&str, ProviderKind, i64) -> Result<UsageSnapshot, Error>,
) -> Result<UsageSnapshot, Error> {
    let catalog = match OpenCodeCatalog::read() {
        Ok(catalog) => catalog,
        Err(error) => {
            return Ok(UsageSnapshot::unavailable(
                spec.kind,
                format!(
                    "OpenCode could not be asked what is connected: {}",
                    error.message
                ),
            ));
        }
    };

    match plan_request(&catalog, spec, spec.path) {
        PlanRequest::Unavailable(snapshot) => Ok(snapshot),
        PlanRequest::Fetch { url, auth } => {
            let payload = http::get_json(&url, &auth)?;
            // Stamped at read time, not at app start: a stale stamp makes a
            // reading fetched seconds ago claim it was fetched when the app
            // launched, and the freshness label reports that lie as hours.
            let now_ms = crate::shared::clock::Clock::now_ms(&crate::shared::clock::SystemClock);
            decode(&payload, spec.kind, now_ms)
        }
    }
}

/// Reads any authenticated monitor endpoint for the plan, decoding the reply.
///
/// The same decide-half as [`read_usage`] — OpenCode reachable, plan
/// connected, usable key, known host — with a caller-supplied path (which may
/// carry a query string), so one provider can read several endpoints without
/// duplicating the decision. "No data" outcomes are errors here, unlike the
/// usage path: account analytics has no unavailable-snapshot shape, and the
/// stats UI renders the failure as its own state.
pub(crate) fn read_monitor_json(
    spec: &PlanSpec,
    path_with_query: &str,
    decode: impl Fn(&str, i64) -> Result<AccountUsage, Error>,
) -> Result<AccountUsage, Error> {
    let catalog = OpenCodeCatalog::read().map_err(|error| {
        Error::new(
            ErrorKind::ProviderMissing,
            format!(
                "OpenCode could not be asked what is connected: {}",
                error.message
            ),
        )
    })?;

    let swapped_path = path_with_query;
    let (url, auth) = match plan_request(&catalog, spec, swapped_path) {
        PlanRequest::Unavailable(snapshot) => {
            return Err(Error::new(
                ErrorKind::ProviderMissing,
                snapshot.reason.unwrap_or_else(|| {
                    format!(
                        "The {} analytics read is unavailable.",
                        spec.kind.display_name()
                    )
                }),
            ));
        }
        PlanRequest::Fetch { url, auth } => (url, auth),
    };

    let payload = http::get_json(&url, &auth)?;
    let now_ms = crate::shared::clock::Clock::now_ms(&crate::shared::clock::SystemClock);
    decode(&payload, now_ms)
}

/// The provider status for a plan: everything routes through the `opencode`
/// executable, so that is what "installed" means here.
pub(crate) fn opencode_status(kind: ProviderKind) -> ProviderStatus {
    match crate::modules::providers::codex::probe(OPENCODE_EXECUTABLE) {
        Ok(version) => ProviderStatus {
            kind,
            executable: OPENCODE_EXECUTABLE.to_string(),
            installed: true,
            version: Some(version),
            reason: None,
        },
        Err(error) => ProviderStatus {
            kind,
            executable: OPENCODE_EXECUTABLE.to_string(),
            installed: false,
            version: None,
            reason: Some(error.message),
        },
    }
}

/// The refusal every plan provider gives for a capability it must not fake.
pub(crate) fn unsupported(kind: ProviderKind, what: &str) -> Error {
    Error::new(
        ErrorKind::InvalidRequest,
        format!("{} does not support {what}.", kind.display_name()),
    )
}

// ---------------------------------------------------------------------------
// Scheduled kickoff
// ---------------------------------------------------------------------------

/// A decided kickoff: either an honest refusal or a request to send.
pub(crate) enum KickoffRequest {
    /// Nothing to send; the reason is shown as the attempt's outcome.
    Refused(String),
    /// The chat-completions URL and the credential for it.
    Send { url: String, key: String },
}

/// The full chat-completions URL for a plan id.
///
/// The catalog carries a base URL for some plans; where it does not, the
/// vendor's documented coding base is used. The coding base is what draws
/// plan quota — the general API base would bill pay-as-you-go credit instead.
pub(crate) fn chat_url(provider_id: &str, api_base: Option<&str>) -> Option<String> {
    let base = match provider_id {
        "zai-coding-plan" => api_base.unwrap_or("https://api.z.ai/api/coding/paas/v4"),
        "zhipuai-coding-plan" => api_base.unwrap_or("https://open.bigmodel.cn/api/coding/paas/v4"),
        "kimi-for-coding" | "kimi-code-plan-cn" => "https://api.kimi.com/coding/v1",
        "kimi-code-plan-global" => "https://api.kimi.ai/coding/v1",
        "minimax-coding-plan" => "https://api.minimax.io/v1",
        "minimax-cn-coding-plan" => "https://api.minimax.cn/v1",
        _ => return None,
    };
    Some(format!("{base}/chat/completions"))
}

/// Decides what a plan's kickoff needs, without doing it.
///
/// Every precondition is an honest [`KickoffRequest::Refused`] rather than an
/// error: the connected-but-unusable states are the same ones the usage
/// pipeline reports, and the attempt's outcome should say so in place.
pub(crate) fn kickoff_request(catalog: &OpenCodeCatalog, spec: &PlanSpec) -> KickoffRequest {
    let Some(provider_id) = spec
        .family
        .iter()
        .find(|id| catalog.is_connected(id))
        .copied()
    else {
        return KickoffRequest::Refused(format!(
            "The {} coding plan is not connected in OpenCode.",
            spec.kind.display_name()
        ));
    };

    let key = match catalog.api_key(provider_id) {
        Ok(Some(key)) => key,
        Ok(None) => {
            return KickoffRequest::Refused(format!(
                "OpenCode holds no readable {} credential; an OAuth or environment key cannot be used here.",
                spec.kind.display_name()
            ));
        }
        Err(error) => {
            return KickoffRequest::Refused(format!(
                "OpenCode's credential store could not be read: {}",
                error.message
            ));
        }
    };

    let subscriptions = catalog.subscriptions();
    let api_base = subscriptions
        .iter()
        .find(|sub| sub.provider_id == provider_id)
        .and_then(|sub| sub.api_base.clone());

    match chat_url(provider_id, api_base.as_deref()) {
        Some(url) => KickoffRequest::Send { url, key },
        None => KickoffRequest::Refused(format!("No chat endpoint is known for `{provider_id}`.")),
    }
}

pub(crate) fn kickoff_models(
    spec: &PlanSpec,
    efforts_for_model: impl Fn(&str) -> Vec<KickoffEffortInfo>,
) -> Result<Vec<KickoffModelInfo>, Error> {
    let catalog = OpenCodeCatalog::read()?;
    let Some(provider_id) = spec
        .family
        .iter()
        .find(|id| catalog.is_connected(id))
        .copied()
    else {
        return Ok(Vec::new());
    };

    Ok(opencode::available_models()?
        .into_iter()
        .filter(|model| model.provider_id == provider_id)
        .map(|model| {
            KickoffModelInfo::new(
                model.provider_id,
                model.model_id.clone(),
                kickoff_model_label(provider_id, &model.model_id),
                efforts_for_model(&model.model_id),
            )
        })
        .collect())
}

/// Sends a plan's scheduled kickoff end to end.
///
/// `body` builds the vendor-specific request and `decode_reply` extracts the
/// reply text — both supplied by the provider module, both pure and unit-tested
/// there. A precondition failure is a refused [`PingOutcome`], not an error,
/// so the schedule records it as the attempt's outcome either way.
pub(crate) fn send_kickoff(
    spec: &PlanSpec,
    prompt: &str,
    model: &str,
    effort: &str,
    body: impl Fn(&str, &str, &str) -> String,
    decode_reply: impl Fn(&str) -> Result<String, Error>,
) -> Result<PingOutcome, Error> {
    match OpenCodeCatalog::read() {
        Ok(catalog) => send_kickoff_with(&catalog, spec, prompt, model, effort, body, decode_reply),
        Err(error) => Ok(refused(format!(
            "OpenCode could not be asked what is connected: {}",
            error.message
        ))),
    }
}

/// The same send over an explicit catalog, so the decision paths are testable
/// without spawning the OpenCode CLI.
pub(crate) fn send_kickoff_with(
    catalog: &OpenCodeCatalog,
    spec: &PlanSpec,
    prompt: &str,
    model: &str,
    effort: &str,
    body: impl Fn(&str, &str, &str) -> String,
    decode_reply: impl Fn(&str) -> Result<String, Error>,
) -> Result<PingOutcome, Error> {
    let (url, key) = match kickoff_request(catalog, spec) {
        KickoffRequest::Refused(reason) => return Ok(refused(reason)),
        KickoffRequest::Send { url, key } => (url, key),
    };

    let payload = http::post_json(&url, &AuthHeader::Bearer(key), &body(model, prompt, effort))?;
    let reply = decode_reply(&payload)?;

    Ok(PingOutcome {
        accepted: true,
        reply,
        usage: None,
        reason: None,
    })
}

/// The outcome for a kickoff that never became a request.
fn refused(reason: String) -> PingOutcome {
    PingOutcome {
        accepted: false,
        reply: String::new(),
        usage: None,
        reason: Some(reason),
    }
}

/// Asserts the pipeline contract on a spec: every family member must have a
/// host, or the read would silently degrade.
#[cfg(test)]
pub(crate) fn assert_spec_is_sound(spec: &PlanSpec) {
    assert!(
        spec.family.iter().all(|id| quota_host(id).is_some()),
        "every plan id in the {} family must have a quota host",
        spec.kind.as_str()
    );
    assert!(!spec.path.is_empty());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::opencode::fixture_catalog;
    use crate::shared::domain::CredentialOrigin;

    const LISTING: &str = r#"{"data":[
        {"id":"zai-coding-plan","name":"Z.AI Coding Plan"},
        {"id":"minimax-coding-plan","name":"MiniMax Token Plan"}
    ]}"#;
    const EXPORT_KEY: &str = r#"[{"id":"c1","integrationID":"zai-coding-plan","label":"Z.AI",
             "value":{"type":"key","key":"stored-key"}}]"#;
    const EXPORT_OAUTH: &str = r#"[{"id":"c1","integrationID":"zai-coding-plan","label":"Z.AI",
             "value":{"type":"oauth","refresh":"r","access":"a","expires":1}}]"#;

    fn spec() -> PlanSpec {
        PlanSpec {
            kind: ProviderKind::Zai,
            family: &["zai-coding-plan", "zhipuai-coding-plan"],
            path: "/api/monitor/usage/quota/limit",
            bearer: false,
        }
    }

    #[test]
    fn a_connected_plan_with_a_stored_key_yields_a_fetch() {
        let catalog = fixture_catalog(LISTING, EXPORT_KEY);
        let PlanRequest::Fetch { url, auth } = plan_request(&catalog, &spec(), spec().path) else {
            panic!("expected a fetch");
        };
        assert_eq!(url, "https://api.z.ai/api/monitor/usage/quota/limit");
        match auth {
            AuthHeader::Raw(key) => assert_eq!(key, "stored-key"),
            AuthHeader::Bearer(_) => panic!("z.ai must not use bearer auth"),
        }
    }

    #[test]
    fn a_bearer_plan_asks_for_bearer_auth() {
        let catalog = fixture_catalog(
            LISTING,
            r#"[{"id":"c2","integrationID":"minimax-coding-plan","label":"MiniMax",
                 "value":{"type":"key","key":"mm-key"}}]"#,
        );
        let minimax_spec = PlanSpec {
            kind: ProviderKind::Minimax,
            family: &["minimax-coding-plan"],
            path: "/v1/token_plan/remains",
            bearer: true,
        };
        let PlanRequest::Fetch { url, auth } =
            plan_request(&catalog, &minimax_spec, minimax_spec.path)
        else {
            panic!("expected a fetch");
        };
        assert_eq!(url, "https://api.minimax.io/v1/token_plan/remains");
        assert!(matches!(auth, AuthHeader::Bearer(_)));
    }

    #[test]
    fn an_unconnected_plan_is_unavailable_not_an_error() {
        let catalog = fixture_catalog(LISTING, EXPORT_KEY);
        let kimi_spec = PlanSpec {
            kind: ProviderKind::Kimi,
            family: &["kimi-for-coding"],
            path: "/coding/v1/usages",
            bearer: true,
        };
        let PlanRequest::Unavailable(snapshot) = plan_request(&catalog, &kimi_spec, kimi_spec.path)
        else {
            panic!("expected unavailable");
        };
        assert!(snapshot.reason.expect("reason").contains("not connected"));
    }

    #[test]
    fn an_oauth_only_credential_is_honestly_unusable() {
        let catalog = fixture_catalog(LISTING, EXPORT_OAUTH);
        let PlanRequest::Unavailable(snapshot) = plan_request(&catalog, &spec(), spec().path)
        else {
            panic!("expected unavailable");
        };
        assert!(snapshot.reason.expect("reason").contains("no readable"));
    }

    #[test]
    fn the_fixture_catalog_reports_stored_credentials() {
        let catalog = fixture_catalog(LISTING, EXPORT_KEY);
        assert_eq!(
            catalog.api_key("zai-coding-plan").expect("reads"),
            Some("stored-key".into())
        );
        let subscriptions = catalog.subscriptions();
        assert_eq!(subscriptions[0].credential, CredentialOrigin::Stored);
    }

    mod kickoff {
        use super::*;
        use crate::modules::providers::zai::protocol as zai_protocol;

        fn spec() -> PlanSpec {
            PlanSpec {
                kind: ProviderKind::Zai,
                family: &["zai-coding-plan", "zhipuai-coding-plan"],
                path: "/api/monitor/usage/quota/limit",
                bearer: false,
            }
        }

        #[test]
        fn a_connected_key_plan_resolves_to_the_coding_chat_url() {
            let catalog = fixture_catalog(LISTING, EXPORT_KEY);
            let KickoffRequest::Send { url, key } = kickoff_request(&catalog, &spec()) else {
                panic!("expected a send");
            };
            assert_eq!(url, "https://api.z.ai/api/coding/paas/v4/chat/completions");
            assert_eq!(key, "stored-key");
        }

        #[test]
        fn an_unconnected_plan_is_refused_not_errored() {
            let catalog = fixture_catalog(LISTING, EXPORT_KEY);
            let kimi_spec = PlanSpec {
                kind: ProviderKind::Kimi,
                family: &["kimi-for-coding"],
                path: "/coding/v1/usages",
                bearer: true,
            };
            let KickoffRequest::Refused(reason) = kickoff_request(&catalog, &kimi_spec) else {
                panic!("expected a refusal");
            };
            assert!(reason.contains("not connected"));
        }

        #[test]
        fn a_kickoff_over_a_fixture_catalog_refuses_instead_of_sending() {
            // The decision paths must be provable without spawning the CLI —
            // a real send here would spend the plan's actual quota.
            let oauth_only = fixture_catalog(LISTING, EXPORT_OAUTH);
            let outcome = send_kickoff_with(
                &oauth_only,
                &spec(),
                "hi",
                "glm-5.3",
                "low",
                zai_protocol::kickoff_body,
                zai_protocol::decode_kickoff_reply,
            )
            .expect("refusals are outcomes");
            assert!(!outcome.accepted);
            assert!(outcome.reason.expect("reason").contains("no readable"));
        }

        #[test]
        fn every_family_plan_has_a_chat_url() {
            for id in [
                "zai-coding-plan",
                "zhipuai-coding-plan",
                "minimax-coding-plan",
                "minimax-cn-coding-plan",
                "kimi-for-coding",
                "kimi-code-plan-cn",
                "kimi-code-plan-global",
            ] {
                assert!(chat_url(id, None).is_some(), "{id} lost its chat endpoint");
            }
        }

        #[test]
        fn a_pay_as_you_go_id_has_no_chat_url() {
            assert!(chat_url("openai", None).is_none());
        }

        #[test]
        fn the_zai_catalog_base_url_wins_over_the_fallback() {
            assert_eq!(
                chat_url(
                    "zai-coding-plan",
                    Some("https://api.z.ai/api/coding/paas/v4")
                )
                .expect("url"),
                "https://api.z.ai/api/coding/paas/v4/chat/completions"
            );
        }
    }
}
