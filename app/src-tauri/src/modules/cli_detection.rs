//! Read-only detection for coding-agent command-line tools.
//!
//! Detection is intentionally separate from provider usage integrations: an
//! installed CLI is not evidence that AgentGauge can read its usage data.

use std::process::Stdio;

use serde::{Deserialize, Serialize};

use crate::shared::executable::{self, ResolvedExecutable};

const CODEX_PATH_OVERRIDE: &str = "AGENTGAUGE_CODEX_PATH";
const OPENCODE_PATH_OVERRIDE: &str = "AGENTGAUGE_OPENCODE_PATH";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CliTool {
    Codex,
    OpenCode,
}

impl CliTool {
    const fn executable(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
        }
    }

    const fn display_name(self) -> &'static str {
        match self {
            Self::Codex => "Codex CLI",
            Self::OpenCode => "OpenCode CLI",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliToolStatus {
    pub tool: CliTool,
    pub display_name: String,
    pub executable: String,
    pub installed: bool,
    pub version: Option<String>,
    pub reason: Option<String>,
}

/// Runs only each CLI's version command; no agent session or server is started.
pub fn detect() -> Vec<CliToolStatus> {
    [CliTool::Codex, CliTool::OpenCode]
        .into_iter()
        .map(detect_one)
        .collect()
}

fn detect_one(tool: CliTool) -> CliToolStatus {
    let override_variable = match tool {
        CliTool::Codex => CODEX_PATH_OVERRIDE,
        CliTool::OpenCode => OPENCODE_PATH_OVERRIDE,
    };
    detect_executable(tool, tool.executable(), override_variable)
}

fn detect_executable(tool: CliTool, executable: &str, override_variable: &str) -> CliToolStatus {
    let Some(candidate) = executable::resolve(executable, override_variable) else {
        return unavailable(
            tool,
            executable,
            executable::not_found_reason(override_variable),
        );
    };
    match detect_candidate(tool, candidate) {
        Ok(status) => status,
        Err((path, reason)) => unavailable(tool, &path, reason),
    }
}

fn detect_candidate(
    tool: CliTool,
    candidate: ResolvedExecutable,
) -> Result<CliToolStatus, (String, String)> {
    let path = candidate.path().to_string_lossy().into_owned();
    let result = candidate
        .command()
        .arg("--version")
        .stdin(Stdio::null())
        .output();
    match result {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            Ok(CliToolStatus {
                tool,
                display_name: tool.display_name().to_owned(),
                executable: path,
                installed: true,
                version: (!text.is_empty()).then_some(text),
                reason: None,
            })
        }
        Ok(output) => Err((
            path.clone(),
            format!(
                "{} --version exited with {}.",
                tool.display_name(),
                output.status
            ),
        )),
        Err(error) => Err((
            path.clone(),
            format!("Could not run {} --version ({error}).", tool.display_name()),
        )),
    }
}

fn unavailable(tool: CliTool, executable: &str, reason: String) -> CliToolStatus {
    CliToolStatus {
        tool,
        display_name: tool.display_name().to_owned(),
        executable: executable.to_owned(),
        installed: false,
        version: None,
        reason: Some(reason),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_only_the_tools_with_detection_support() {
        assert_eq!(
            detect()
                .iter()
                .map(|status| status.tool)
                .collect::<Vec<_>>(),
            [CliTool::Codex, CliTool::OpenCode]
        );
    }

    #[test]
    fn missing_executable_is_an_explicit_uninstalled_status() {
        let status = detect_executable(
            CliTool::Codex,
            "agentgauge-test-command-that-does-not-exist",
            CODEX_PATH_OVERRIDE,
        );
        assert!(!status.installed);
        assert!(status.version.is_none());
        assert!(status.reason.is_some());
    }

    #[cfg(unix)]
    #[test]
    fn failed_version_check_does_not_put_the_executable_path_in_the_reason() {
        use std::os::unix::fs::PermissionsExt;

        let directory = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.temp/cli-detection-tests")
            .join(format!("failed-version-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create fixture directory");
        let path = directory.join("codex");
        std::fs::write(&path, "#!/bin/sh\nexit 7\n").expect("write fixture executable");
        let mut permissions = std::fs::metadata(&path)
            .expect("read fixture permissions")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).expect("make fixture executable");

        let status = detect_executable(
            CliTool::Codex,
            path.to_str().expect("fixture path is UTF-8"),
            CODEX_PATH_OVERRIDE,
        );
        let reason = status.reason.expect("failed check has a reason");
        let _ = std::fs::remove_dir_all(directory);

        assert!(!status.installed);
        assert!(!reason.contains(path.to_str().expect("fixture path is UTF-8")));
    }

    #[test]
    fn status_serializes_for_the_renderer() {
        let status = CliToolStatus {
            tool: CliTool::OpenCode,
            display_name: "OpenCode CLI".to_owned(),
            executable: "opencode".to_owned(),
            installed: true,
            version: Some("1.2.3".to_owned()),
            reason: None,
        };
        let value = serde_json::to_value(status).expect("serializes");
        assert_eq!(value["tool"], "openCode");
        assert_eq!(value["displayName"], "OpenCode CLI");
        assert_eq!(value["version"], "1.2.3");
    }
}
