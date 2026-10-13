//! Update-channel detection and explicitly requested Homebrew upgrades.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::shared::error::Error;

const TAP: &str = "soumitro-saha/agentgauge";
const CASK: &str = "soumitro-saha/agentgauge/agentgauge";
static UPGRADE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Direct,
    Homebrew,
}

pub fn channel() -> UpdateChannel {
    if installation().is_some() {
        UpdateChannel::Homebrew
    } else {
        UpdateChannel::Direct
    }
}

pub fn upgrade(version: &str) -> Result<(), Error> {
    if !valid_version(version) {
        return Err(Error::invalid_request("Invalid release version."));
    }
    let _lock = UPGRADE_LOCK
        .try_lock()
        .map_err(|_| Error::invalid_request("A Homebrew upgrade is already running."))?;
    let (brew, app) = installation()
        .ok_or_else(|| Error::invalid_request("This copy is not managed by Homebrew."))?;
    let prefix = brew.parent().and_then(Path::parent).ok_or_else(|| {
        Error::invalid_request("Homebrew's installation directory is unavailable.")
    })?;
    if !is_cask_app(prefix, &app) {
        return Err(Error::invalid_request("This copy is not installed from the AgentGauge Homebrew tap. Use its installed tap in Terminal."));
    }
    let appdir = app
        .parent()
        .ok_or_else(|| Error::invalid_request("No app directory."))?;
    let status = run_brew(
        &brew,
        &[
            "upgrade",
            "--cask",
            "--no-quit",
            "--yes",
            "--appdir",
            appdir
                .to_str()
                .ok_or_else(|| Error::invalid_request("Invalid app directory."))?,
            CASK,
        ],
    )?;
    if !status {
        return Err(Error::provider_error("Homebrew could not upgrade AgentGauge. Run `brew upgrade --cask soumitro-saha/agentgauge/agentgauge` in Terminal for details."));
    }
    if !is_cask_app(prefix, &app) {
        return Err(Error::provider_error(
            "Homebrew no longer manages this app. Check the installation in Terminal.",
        ));
    }
    let installed = Command::new(&brew)
        .args(["list", "--cask", "--versions", CASK])
        .stdin(Stdio::null())
        .output()
        .map_err(|_| Error::provider_error("Could not verify the Homebrew installation."))?;
    let versions = String::from_utf8_lossy(&installed.stdout);
    if !installed.status.success() || !versions.split_whitespace().any(|part| part == version) {
        return Err(Error::provider_error("Homebrew finished without installing the expected version. Check the tap and try again."));
    }
    Ok(())
}

fn valid_version(version: &str) -> bool {
    version.split('.').count() == 3
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
}

fn run_brew(brew: &Path, args: &[&str]) -> Result<bool, Error> {
    let mut child = Command::new(brew)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| Error::provider_error("Could not start Homebrew."))?;
    let deadline = Instant::now() + Duration::from_secs(600);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.success()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(200)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::provider_error("Homebrew did not finish within ten minutes. Check the installation in Terminal."));
            }
        }
    }
}

fn installation() -> Option<(PathBuf, PathBuf)> {
    let exe = std::env::current_exe().ok()?;
    let app = exe
        .ancestors()
        .find(|path| path.extension().is_some_and(|ext| ext == "app"))?;
    for brew in ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"] {
        let path = Path::new(brew);
        if path.is_file() && has_cask_artifact(path.parent()?.parent()?, app) {
            return Some((path.to_path_buf(), app.to_path_buf()));
        }
    }
    None
}

fn is_cask_app(prefix: &Path, app: &Path) -> bool {
    let receipt = prefix.join("Caskroom/agentgauge/.metadata/INSTALL_RECEIPT.json");
    let source = std::fs::read(receipt)
        .ok()
        .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok());
    source
        .as_ref()
        .and_then(|value| value.pointer("/source/tap"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|tap| tap.eq_ignore_ascii_case(TAP))
        && has_cask_artifact(prefix, app)
}

fn has_cask_artifact(prefix: &Path, app: &Path) -> bool {
    let Some(real_app) = app.canonicalize().ok() else {
        return false;
    };
    let Ok(versions) = std::fs::read_dir(prefix.join("Caskroom/agentgauge")) else {
        return false;
    };
    versions.flatten().any(|version| {
        version
            .path()
            .join("AgentGauge.app")
            .canonicalize()
            .ok()
            .as_ref()
            == Some(&real_app)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_validation_refuses_untrusted_arguments() {
        assert!(valid_version("0.2.0"));
        assert!(!valid_version("0.2.0; rm -rf ~"));
        assert!(!valid_version("1.2"));
    }

    #[cfg(unix)]
    #[test]
    fn detection_requires_the_running_bundle_to_match_the_cask_receipt() {
        use std::os::unix::fs::symlink;
        let temp = std::env::temp_dir().join(format!(
            "agentgauge-brew-detect-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos(),
        ));
        let app = temp.join("Applications/AgentGauge.app");
        std::fs::create_dir_all(&app).expect("app");
        let cask = temp.join("Caskroom/agentgauge/0.2.0");
        std::fs::create_dir_all(&cask).expect("cask");
        assert!(!is_cask_app(&temp, &app));
        symlink(&app, cask.join("AgentGauge.app")).expect("receipt");
        assert!(has_cask_artifact(&temp, &app));
        assert!(!is_cask_app(&temp, &app));
        let receipt = temp.join("Caskroom/agentgauge/.metadata/INSTALL_RECEIPT.json");
        std::fs::create_dir_all(receipt.parent().expect("metadata")).expect("metadata");
        std::fs::write(&receipt, r#"{"source":{"tap":"another/agentgauge"}}"#).expect("receipt");
        assert!(!is_cask_app(&temp, &app));
        std::fs::write(&receipt, r#"{"source":{"tap":"soumitro-saha/agentgauge"}}"#)
            .expect("receipt");
        assert!(is_cask_app(&temp, &app));
        let other = temp.join("Applications/Another.app");
        std::fs::create_dir_all(&other).expect("other");
        assert!(!is_cask_app(&temp, &other));
        std::fs::remove_dir_all(&temp).expect("remove fixture");
    }
}
