//! Read-only detection for coding-agent command-line tools.
//!
//! Detection is intentionally separate from provider usage integrations: an
//! installed CLI is not evidence that AgentGauge can read its usage data.

use std::process::Command;

use serde::{Deserialize, Serialize};

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
    detect_executable(tool, tool.executable())
}

fn detect_executable(tool: CliTool, executable: &str) -> CliToolStatus {
    let result = Command::new(executable).arg("--version").output();
    let (installed, version, reason) = match result {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if text.is_empty() {
                (true, None, None)
            } else {
                (true, Some(text), None)
            }
        }
        Ok(output) => (
            false,
            None,
            Some(format!("Version check exited with {}.", output.status)),
        ),
        Err(error) => (
            false,
            None,
            Some(format!("Executable was not found on PATH ({error}).")),
        ),
    };

    CliToolStatus {
        tool,
        display_name: tool.display_name().to_owned(),
        executable: executable.to_owned(),
        installed,
        version,
        reason,
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
        );
        assert!(!status.installed);
        assert!(status.version.is_none());
        assert!(status.reason.is_some());
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
