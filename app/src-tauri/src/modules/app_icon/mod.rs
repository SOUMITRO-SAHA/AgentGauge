//! The macOS Dock tile for a binary that is not inside an `.app`.
//!
//! macOS draws a Dock tile from the enclosing app bundle's `Info.plist`. The e2e
//! harness and a bare `cargo run` launch `target/debug/agentgauge` with no
//! bundle, so there is no `CFBundleIconFile` to read and the Dock falls back to
//! the generic executable tile — a black square reading `exec`.
//!
//! Tauri covers this for `tauri dev` by embedding the icon bytes and calling
//! `NSApplication.setApplicationIconImage` under `cfg(dev)`, a flag only the
//! Tauri CLI sets. The e2e binary is a plain `cargo build`, so it never gets
//! one. This module performs the same call for any unbundled debug run.
//!
//! A bundled build is left alone on purpose: its icon comes from the bundle, and
//! overriding it would hide a packaging mistake instead of surfacing it.
//!
//! Debug-only by construction. A release build is expected to run from the
//! `.app` that `bun run build:mac` produces, where the bundle already carries
//! the icon, so the module is compiled out entirely for release and for every
//! platform but macOS.

use std::path::Path;

use objc2::{AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSImage};
use objc2_foundation::NSData;

use crate::shared::bundle::bundle_root;

/// The same `icon.icns` the bundle ships, so an unbundled run and a bundled run
/// show one identical tile.
const ICON: &[u8] = include_bytes!("../../../icons/icon.icns");

/// Whether this binary has to hand macOS its own Dock tile.
///
/// Unbundled means no `Info.plist`, and no `Info.plist` means no
/// `CFBundleIconFile` — so nothing tells the Dock what to draw.
fn needs_manual_icon(exe: &Path) -> bool {
    bundle_root(exe).is_none()
}

/// Gives the running process its Dock tile, if it does not already have one.
///
/// Called from the composition root on `RunEvent::Ready`, which is the first
/// point at which the Dock tile exists; `apply` re-checks the thread rather
/// than trusting the caller.
pub fn install() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    if needs_manual_icon(&exe) {
        apply(ICON);
    }
}

/// Hands the icon bytes to `NSApplication`, which is what the Dock tile reads.
fn apply(icon: &[u8]) {
    let Some(marker) = MainThreadMarker::new() else {
        return;
    };
    let Some(image) = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(icon)) else {
        return;
    };
    let app = NSApplication::sharedApplication(marker);
    // SAFETY: `image` is a retained `NSImage` outliving this call, and
    // `setApplicationIconImage:` only reads it.
    unsafe { app.setApplicationIconImage(Some(&image)) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unbundled_binary_has_to_supply_its_own_icon() {
        assert!(needs_manual_icon(Path::new(
            "/repo/app/src-tauri/target/debug/agentgauge"
        )));
    }

    #[test]
    fn a_bundled_binary_is_left_to_its_own_info_plist() {
        assert!(!needs_manual_icon(Path::new(
            "/Applications/AgentGauge.app/Contents/MacOS/agentgauge"
        )));
    }

    #[test]
    fn the_embedded_icon_is_the_one_the_bundle_ships() {
        assert!(
            ICON.starts_with(b"icns"),
            "icon.icns must start with the 'icns' magic, got {:?}",
            &ICON[..4.min(ICON.len())]
        );
    }
}
