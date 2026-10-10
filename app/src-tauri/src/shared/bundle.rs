//! Where the running executable sits on disk, and the app bundle around it.
//!
//! A macOS binary launched from `AgentGauge.app` resolves its `Info.plist`,
//! bundle identifier and Dock icon from the enclosing bundle. The very same
//! binary run by `cargo` has none of those, because there is no bundle to read
//! them from.
//!
//! Two modules need to tell those cases apart: the widget module, to decide
//! whether its extension is embedded, and the app-icon module, to decide whether
//! macOS already has an icon to show. The rule therefore lives here rather than
//! in either of them.

use std::path::{Path, PathBuf};

/// The `.app` root for a running executable.
///
/// A bundled executable lives at `<App>.app/Contents/MacOS/<name>`, so the root is
/// two levels up. `None` for an unbundled binary, which is what `tauri dev` and
/// the e2e harness run.
pub fn bundle_root(exe: &Path) -> Option<PathBuf> {
    let macos_dir = exe.parent()?;
    if macos_dir.file_name()? != "MacOS" {
        return None;
    }
    let contents = macos_dir.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    let root = contents.parent()?;
    if root.extension()?.to_str()? != "app" {
        return None;
    }
    Some(root.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bundled_executable_is_recognised_and_a_dev_binary_is_not() {
        let bundled = Path::new("/Applications/AgentGauge.app/Contents/MacOS/agentgauge");
        assert_eq!(
            bundle_root(bundled),
            Some(PathBuf::from("/Applications/AgentGauge.app"))
        );

        let unbundled = Path::new("/repo/target/debug/agentgauge");
        assert_eq!(bundle_root(unbundled), None);
    }

    #[test]
    fn only_an_exact_bundle_layout_counts() {
        let looks_almost_right = Path::new("/repo/AgentGauge.app/MacOS/agentgauge");
        assert_eq!(bundle_root(looks_almost_right), None);

        let not_an_app = Path::new("/repo/AgentGauge.bundle/Contents/MacOS/agentgauge");
        assert_eq!(bundle_root(not_an_app), None);
    }

    #[test]
    fn a_path_with_no_parent_has_no_bundle() {
        assert_eq!(bundle_root(Path::new("agentgauge")), None);
    }
}
