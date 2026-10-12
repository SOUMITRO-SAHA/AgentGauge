//! Facts about this build, and the outbound links the Settings screen offers.
//!
//! Every outbound URL lives here, not in the renderer: the repository, the
//! prefilled issue forms, and the funding destinations are data the app owns,
//! and one owner keeps a moved repository from stranding stale links across
//! components. The renderer receives them through `appInfo` and opens them
//! back through [`open_link`], whose allowlist admits exactly the destinations
//! this module itself generates — so the app cannot be used as a generic URL
//! opener, and the destinations a build can reach are auditable in one list.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::shared::error::{Error, ErrorKind};
use crate::shared::platform::macos_version;

/// The project's home on GitHub, and the prefix of every repository link.
pub const REPOSITORY_URL: &str = "https://github.com/SOUMITRO-SAHA/AgentGauge";

/// The one place this build's links may point: the repository (and paths under
/// it) and the funding destinations. A longer path must continue the prefix at
/// a `/`, `?`, or `#` boundary, so `…/AgentGauge-evil` is not the repository.
const ALLOWED_PREFIXES: [&str; 3] = [
    "https://github.com/SOUMITRO-SAHA/AgentGauge",
    "https://github.com/sponsors/SOUMITRO-SAHA",
    "https://www.patreon.com/SOUMITROSAHA",
];

/// What the Settings screen's About panel renders.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// This build's version, from the Tauri package info.
    pub app_version: String,
    /// The platform constant, e.g. `"macos"` — the renderer labels it.
    pub os: String,
    /// The architecture the binary was built for, e.g. `"aarch64"`.
    pub arch: String,
    /// The OS's own version string, when the platform reports one.
    pub os_version: Option<String>,
    /// The same facts as a short Markdown block, for pasting into an issue.
    pub diagnostics: String,
    pub links: AppLinks,
}

/// The outbound destinations this build offers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppLinks {
    pub repository: String,
    pub releases: String,
    /// A new-issue URL with the diagnostics block prefilled into the form.
    pub bug_report: String,
    /// A new-issue URL for enhancement requests.
    pub feature_request: String,
    /// The live funding destinations, in display order.
    pub funding: Vec<FundingLink>,
}

/// One place a reader can support the project.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FundingLink {
    pub label: String,
    pub url: String,
}

/// Assembles the build facts and links for the Settings screen.
pub fn app_info(app_version: &str) -> AppInfo {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let os_version = macos_version();
    let diagnostics = diagnostics_block(app_version, os, os_version.as_deref(), arch);
    let links = AppLinks {
        repository: REPOSITORY_URL.to_string(),
        releases: format!("{REPOSITORY_URL}/releases"),
        bug_report: format!(
            "{REPOSITORY_URL}/issues/new?template=bug_report.yml&diagnostics={}",
            encode_component(&diagnostics)
        ),
        feature_request: format!("{REPOSITORY_URL}/issues/new?template=feature_request.yml"),
        funding: vec![
            FundingLink {
                label: "GitHub Sponsors".to_string(),
                url: "https://github.com/sponsors/SOUMITRO-SAHA".to_string(),
            },
            FundingLink {
                label: "Patreon".to_string(),
                url: "https://www.patreon.com/SOUMITROSAHA".to_string(),
            },
        ],
    };
    AppInfo {
        app_version: app_version.to_string(),
        os: os.to_string(),
        arch: arch.to_string(),
        os_version,
        diagnostics,
        links,
    }
}

/// The short Markdown block prefilled into bug reports: build facts only.
///
/// Deliberately excludes everything a user has not chosen to share — no usage
/// numbers, no plan names, no paths beyond the platform constant — because an
/// issue is public forever once filed.
fn diagnostics_block(app_version: &str, os: &str, os_version: Option<&str>, arch: &str) -> String {
    let system = match os_version {
        Some(version) => format!("{} {version}", display_os(os)),
        None => display_os(os).to_string(),
    };
    format!("### System diagnostics\n\n- AgentGauge: {app_version}\n- System: {system} ({arch})")
}

/// Opens one of this app's own outbound links in the user's browser.
///
/// Anything the allowlist does not name is refused before the opener runs.
pub fn open_link(app: &AppHandle, url: &str) -> Result<(), Error> {
    if !is_allowed(url) {
        return Err(Error::invalid_request(
            "That link is not one this app opens.",
        ));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| Error::new(ErrorKind::InvalidRequest, "The link could not be opened."))
}

fn is_allowed(url: &str) -> bool {
    ALLOWED_PREFIXES.iter().any(|prefix| {
        url.len() >= prefix.len()
            && url.get(..prefix.len()) == Some(*prefix)
            && url[prefix.len()..]
                .chars()
                .next()
                .is_none_or(|next| matches!(next, '/' | '?' | '#'))
    })
}

/// Percent-encodes one URL component: unreserved characters survive, every
/// other byte becomes `%XX` so a diagnostics block's newlines and Markdown
/// punctuation survive the trip through the query string.
fn encode_component(input: &str) -> String {
    let mut encoded = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char)
            }
            other => encoded.push_str(&format!("%{other:02X}")),
        }
    }
    encoded
}

fn display_os(os: &str) -> &str {
    match os {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_carries_the_build_and_repository_links() {
        let info = app_info("0.1.0");
        assert_eq!(info.app_version, "0.1.0");
        assert_eq!(info.os, std::env::consts::OS);
        assert_eq!(info.arch, std::env::consts::ARCH);
        assert_eq!(info.links.repository, REPOSITORY_URL);
        assert_eq!(info.links.releases, format!("{REPOSITORY_URL}/releases"));
    }

    #[test]
    fn the_bug_report_link_prefills_the_issue_form_diagnostics() {
        let info = app_info("9.9.9");
        let expected_prefix =
            format!("{REPOSITORY_URL}/issues/new?template=bug_report.yml&diagnostics=");
        assert!(info.links.bug_report.starts_with(&expected_prefix));
        let encoded = info
            .links
            .bug_report
            .split("diagnostics=")
            .nth(1)
            .expect("the diagnostics parameter");
        assert!(encoded.contains("9.9.9"));
        assert!(encoded.contains("%0A"), "the block is multi-line");
    }

    #[test]
    fn the_feature_request_link_targets_its_template() {
        let info = app_info("0.1.0");
        assert_eq!(
            info.links.feature_request,
            format!("{REPOSITORY_URL}/issues/new?template=feature_request.yml")
        );
    }

    #[test]
    fn funding_links_name_both_live_destinations() {
        let info = app_info("0.1.0");
        let labels: Vec<_> = info
            .links
            .funding
            .iter()
            .map(|f| f.label.as_str())
            .collect();
        assert_eq!(labels, ["GitHub Sponsors", "Patreon"]);
        assert!(info
            .links
            .funding
            .iter()
            .all(|f| f.url.starts_with("https://")));
    }

    #[test]
    fn the_diagnostics_block_is_short_human_readable_and_honest() {
        let info = app_info("0.1.0");
        assert!(info.diagnostics.contains("AgentGauge: 0.1.0"));
        assert!(info.diagnostics.contains(std::env::consts::ARCH));
        assert!(info.diagnostics.contains(display_os(&info.os)));
        if let Some(version) = &info.os_version {
            assert!(info.diagnostics.contains(version));
        }
        assert!(info.diagnostics.chars().count() < 400);
    }

    #[test]
    fn percent_encoding_leaves_unreserved_characters_alone() {
        assert_eq!(encode_component("aB9-_.~"), "aB9-_.~");
        assert_eq!(encode_component("a b"), "a%20b");
        assert_eq!(encode_component("line\nnext"), "line%0Anext");
        assert_eq!(encode_component("&#=+"), "%26%23%3D%2B");
        assert_eq!(encode_component("é"), "%C3%A9");
    }

    #[test]
    fn the_allowlist_accepts_exactly_the_destinations_the_app_links() {
        let info = app_info("0.1.0");
        assert!(is_allowed(&info.links.repository));
        assert!(is_allowed(&info.links.releases));
        assert!(is_allowed(&info.links.bug_report));
        assert!(is_allowed(&info.links.feature_request));
        for link in &info.links.funding {
            assert!(is_allowed(&link.url));
        }
        assert!(is_allowed(
            "https://github.com/sponsors/SOUMITRO-SAHA?frequency=one-time"
        ));
    }

    #[test]
    fn the_allowlist_rejects_everything_else() {
        assert!(!is_allowed("http://github.com/SOUMITRO-SAHA/AgentGauge"));
        assert!(!is_allowed("https://evil.example/AgentGauge"));
        assert!(!is_allowed(
            "https://github.com/other/AgentGauge/issues/new"
        ));
        assert!(!is_allowed(
            "https://github.com/SOUMITRO-SAHA/AgentGauge-evil/issues"
        ));
        assert!(!is_allowed("javascript:alert(1)"));
        assert!(!is_allowed(""));
    }

    #[test]
    fn display_os_names_the_platforms_the_app_runs_on() {
        assert_eq!(display_os("macos"), "macOS");
        assert_eq!(display_os("windows"), "Windows");
        assert_eq!(display_os("linux"), "Linux");
        assert_eq!(display_os("freebsd"), "freebsd");
    }
}
