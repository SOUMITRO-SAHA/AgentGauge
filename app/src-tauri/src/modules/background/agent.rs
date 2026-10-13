//! The single macOS background registration for widget reads and opted-in automation.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::shared::error::{Error, ErrorKind};

#[cfg(debug_assertions)]
pub const AGENT_LABEL: &str = "com.soumitrasaha.agentgauge.widgetdev.background";
#[cfg(not(debug_assertions))]
pub const AGENT_LABEL: &str = "com.soumitrasaha.agentgauge.background";

#[cfg(debug_assertions)]
const PREVIOUS_KICKOFF_LABEL: &str = "com.soumitrasaha.agentgauge.widgetdev.kickoff";
#[cfg(not(debug_assertions))]
const PREVIOUS_KICKOFF_LABEL: &str = "com.soumitrasaha.agentgauge.kickoff";

#[cfg(debug_assertions)]
const PREVIOUS_REFRESH_LABEL: &str = "com.soumitrasaha.agentgauge.widgetdev.refresh";
#[cfg(not(debug_assertions))]
const PREVIOUS_REFRESH_LABEL: &str = "com.soumitrasaha.agentgauge.refresh";

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn plist(home: &Path, label: &str) -> PathBuf {
    home.join("Library/LaunchAgents")
        .join(format!("{label}.plist"))
}

fn uid() -> Result<String, Error> {
    let output = Command::new("id").arg("-u").output().map_err(|error| {
        Error::storage(format!("Could not determine the current user: {error}"))
    })?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn launchctl(args: &[&str]) -> Result<String, Error> {
    let output = Command::new("launchctl")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| Error::storage(format!("Could not contact launchd: {error}")))?;
    if !output.status.success() {
        return Err(Error::new(
            ErrorKind::ProviderError,
            format!(
                "launchctl {} failed: {}",
                args.first().unwrap_or(&""),
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub fn plist_xml(executable: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict>\
         <key>Label</key><string>{AGENT_LABEL}</string>\
         <key>ProgramArguments</key><array><string>{}</string><string>background-service</string></array>\
         <key>EnvironmentVariables</key><dict>\
         <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>\
         </dict>\
         <key>RunAtLoad</key><true/>\
         <key>KeepAlive</key><true/>\
         <key>ProcessType</key><string>Background</string>\
         </dict></plist>",
        escape(executable)
    )
}

pub fn is_installed() -> bool {
    cfg!(target_os = "macos") && home().is_some_and(|home| plist(&home, AGENT_LABEL).is_file())
}

pub fn install(executable: &Path) -> Result<(), Error> {
    if !cfg!(target_os = "macos") {
        return Err(Error::invalid_request(
            "The background service is available on macOS only.",
        ));
    }
    #[cfg(debug_assertions)]
    if std::env::var_os("AGENTGAUGE_DATA_DIR").is_some() {
        return Ok(());
    }
    let Some(contents) = executable.parent().and_then(Path::parent) else {
        return Ok(());
    };
    if !contents.join("PlugIns/AIStatsWidget.appex").is_dir() {
        return Ok(());
    }
    if is_installed() {
        return Ok(());
    }
    let home =
        home().ok_or_else(|| Error::storage("No home directory for the background service."))?;
    let path = plist(&home, AGENT_LABEL);
    let domain = format!("gui/{}", uid()?);
    let target = format!("{domain}/{AGENT_LABEL}");
    let xml = plist_xml(&executable.to_string_lossy());
    let installed = fs::read_to_string(&path).ok().as_deref() == Some(xml.as_str());
    if !installed {
        fs::create_dir_all(path.parent().expect("LaunchAgents parent")).map_err(|error| {
            Error::storage(format!("Could not create LaunchAgents directory: {error}"))
        })?;
        let _ = launchctl(&["bootout", &target]);
        let temporary = path.with_extension("plist.tmp");
        fs::write(&temporary, xml)
            .and_then(|()| fs::rename(&temporary, &path))
            .map_err(|error| {
                Error::storage(format!("Could not save background registration: {error}"))
            })?;
    }
    if launchctl(&["print", &target]).is_err() {
        launchctl(&["bootstrap", &domain, &path.to_string_lossy()])?;
    }
    let mut running = false;
    for _ in 0..20 {
        if let Ok(status) = launchctl(&["print", &target]) {
            if status
                .lines()
                .any(|line| line.trim_start().starts_with("pid = "))
            {
                running = true;
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    if !running {
        return Err(Error::storage("The replacement background service did not start; previous login jobs were left intact."));
    }
    for label in [PREVIOUS_KICKOFF_LABEL, PREVIOUS_REFRESH_LABEL] {
        let previous = plist(&home, label);
        if previous.is_file() {
            let _ = launchctl(&["bootout", &format!("{domain}/{label}")]);
            fs::remove_file(previous).map_err(|error| {
                Error::storage(format!(
                    "Could not remove the previous background registration: {error}"
                ))
            })?;
        }
    }
    let autostart = home.join("Library/LaunchAgents/AgentGauge.plist");
    if fs::read_to_string(&autostart).ok().is_some_and(|xml| {
        xml.contains("<string>AgentGauge</string>") && xml.contains("agentgauge</string>")
    }) {
        let _ = launchctl(&["bootout", &format!("{domain}/AgentGauge")]);
        fs::remove_file(autostart).map_err(|error| {
            Error::storage(format!(
                "Could not remove the old desktop autostart: {error}"
            ))
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_resident_headless_registration_has_no_second_timer_or_window() {
        let xml = plist_xml("/Applications/A&B.app/Contents/MacOS/agentgauge");
        assert!(xml.contains("A&amp;B.app"));
        assert!(xml.contains("<string>background-service</string>"));
        assert!(xml.contains("<key>KeepAlive</key><true/>"));
        assert!(!xml.contains("StartInterval"));
        assert!(!xml.contains("WatchPaths"));
        assert!(!xml.contains("kickoff-worker"));
        assert!(!xml.contains("widget-refresh-worker"));
    }
}
