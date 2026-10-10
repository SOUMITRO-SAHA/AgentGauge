//! The shared read pipeline for OpenCode-managed coding plans.
//!
//! Every plan provider answers the same three questions in the same order —
//! is OpenCode reachable, is this plan connected, does OpenCode hold a usable
//! key — and only then talks to the vendor's quota endpoint. The steps live
//! here so each provider module is nothing but its spec and its decoder.

use crate::modules::opencode::{quota_host, OpenCodeCatalog, OPENCODE_EXECUTABLE};
use crate::modules::providers::http::{self, AuthHeader};
use crate::shared::domain::{ProviderKind, UsageSnapshot};
use crate::shared::error::{Error, ErrorKind};
use crate::shared::provider::ProviderStatus;

/// What one provider reads and how.
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
pub(crate) fn plan_request(catalog: &OpenCodeCatalog, spec: &PlanSpec) -> PlanRequest {
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
        url: format!("{host}{}", spec.path),
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

    match plan_request(&catalog, spec) {
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
        let PlanRequest::Fetch { url, auth } = plan_request(&catalog, &spec()) else {
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
        let PlanRequest::Fetch { url, auth } = plan_request(&catalog, &minimax_spec) else {
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
        let PlanRequest::Unavailable(snapshot) = plan_request(&catalog, &kimi_spec) else {
            panic!("expected unavailable");
        };
        assert!(snapshot.reason.expect("reason").contains("not connected"));
    }

    #[test]
    fn an_oauth_only_credential_is_honestly_unusable() {
        let catalog = fixture_catalog(LISTING, EXPORT_OAUTH);
        let PlanRequest::Unavailable(snapshot) = plan_request(&catalog, &spec()) else {
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
}
