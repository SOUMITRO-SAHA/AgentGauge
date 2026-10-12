//! Host-platform facts shared by the modules that need to name the OS.

use std::process::Command;

/// The macOS product version, e.g. `"15.3.1"` on macOS 15.3.1.
///
/// Read through `sw_vers` rather than `uname`, whose Darwin kernel version does
/// not map cleanly onto the marketing release — and guessing that mapping wrong
/// would produce a wrong minimum-version verdict. `None` off macOS, where the
/// command does not exist.
pub fn macos_version() -> Option<String> {
    let output = Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8(output.stdout).ok()?;
    let version = version.trim();
    if version.is_empty() {
        return None;
    }
    Some(version.to_string())
}
