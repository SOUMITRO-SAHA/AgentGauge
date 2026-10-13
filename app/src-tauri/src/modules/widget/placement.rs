//! Placement receipts: the only cross-build evidence of a widget on this Mac.
//!
//! `WidgetCenter.getCurrentConfigurations` answers about the calling app alone.
//! chronod keys its configurations per containing app — its own logs name them
//! `<containing bundle id>::<extension bundle id>:<kind>` — so the Release build
//! cannot see a Debug widget and the Debug build cannot see a Release one. No
//! public API crosses that boundary.
//!
//! The widget extension is the only process that runs for a placed widget, so it
//! records a receipt every time WidgetKit renders it outside the gallery, and
//! every AgentGauge app reads all receipts to learn which kinds are on the Mac.
//! That is what lets a Release app recognise the Debug widget a developer has
//! placed, instead of asking a user to place a second one.
//!
//! ## Why a receipt can go stale, and what that costs
//!
//! WidgetKit re-renders a placed widget on its own budget — roughly hourly
//! while the Mac is awake — and never renders a removed one. So a receipt stays
//! inside [`RECEIPT_MAX_AGE_SECS`] for as long as the widget is placed, across a
//! night's sleep and a busy day, and goes stale shortly after removal. The cost
//! is bounded and stated: after the window, a still-placed widget of the *other*
//! build looks absent to this one, which is the safe direction to be wrong in
//! (the user is shown setup steps for a widget they already have). Nothing here
//! is trusted for this build's own kind: WidgetCenter answers that one directly
//! and immediately.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// How long a render receipt still counts as a placement.
///
/// WidgetKit's budget for a placed widget is roughly hourly, so this spans many
/// missed refreshes, a sleep of most of a day, and a Mac that was simply busy —
/// and it still expires promptly after a widget is removed, which is what lets
/// the setup action come back.
pub const RECEIPT_MAX_AGE_SECS: i64 = 12 * 60 * 60;

/// Clock disagreement a receipt may not lead by.
///
/// The writer and the reader are different processes on the same Mac, so a small
/// skew is normal. A receipt far in the future is a clock change or a hand-edited
/// file, and trusting it would suppress the setup action indefinitely.
pub const RECEIPT_MAX_FUTURE_SKEW_SECS: i64 = 5 * 60;

/// The Release build's receipt file, read by every build.
pub const RELEASE_RECEIPT_FILE_NAME: &str = "widget-placement.json";

/// The Debug build's receipt file, read by every build.
pub const DEV_RECEIPT_FILE_NAME: &str = "widget-placement-dev.json";

/// What the widget extension recorded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacementReceipt {
    pub kind: String,
    pub rendered_at: i64,
}

impl PlacementReceipt {
    /// Whether this receipt still counts as a placement at `now_unix`.
    ///
    /// `renderedAt` is whole Unix seconds, as the extension writes it.
    pub fn counts_as_placed_at(&self, now_unix: i64) -> bool {
        let age = now_unix - self.rendered_at;
        age <= RECEIPT_MAX_AGE_SECS && age >= -RECEIPT_MAX_FUTURE_SKEW_SECS
    }
}

/// Reads the receipts in the shared support directory.
#[derive(Debug, Clone)]
pub struct PlacementReceiptStore {
    paths: Vec<PathBuf>,
}

impl PlacementReceiptStore {
    /// Both builds' receipt files in the directory the snapshot uses.
    ///
    /// `AGENTGAUGE_DATA_DIR` is honoured in debug builds, exactly as
    /// `SnapshotStore` does: the e2e harness runs the debug binary against a
    /// sandbox directory, and a receipt reader that looked in the real profile
    /// would make the suite's answers depend on whether the developer has a
    /// widget placed on their own Mac.
    ///
    /// `None` when `HOME` is unset, which is the honest answer: without a home
    /// directory there is nowhere a widget could have written either.
    pub fn from_env() -> Option<Self> {
        #[cfg(debug_assertions)]
        if let Some(dir) = std::env::var_os("AGENTGAUGE_DATA_DIR") {
            return Some(Self::in_directory(dir));
        }
        let home = std::env::var_os("HOME")?;
        let directory = crate::shared::app_support::app_support_dir(&home);
        Some(Self::in_directory(directory))
    }

    /// Both builds' receipt files in `directory`.
    pub fn in_directory(directory: impl AsRef<Path>) -> Self {
        Self {
            paths: [RELEASE_RECEIPT_FILE_NAME, DEV_RECEIPT_FILE_NAME]
                .iter()
                .map(|name| directory.as_ref().join(name))
                .collect(),
        }
    }

    /// The paths this store reads, for tests.
    #[cfg(test)]
    pub fn paths(&self) -> &[PathBuf] {
        &self.paths
    }

    /// Every kind with a receipt inside the freshness window, deduplicated.
    ///
    /// A missing file is normal — most Macs have exactly one build's widget —
    /// and a corrupt one is ignored rather than reported: an unreadable receipt
    /// means "no evidence", never an error the user has to act on.
    pub fn placed_kinds(&self, now_unix: i64) -> Vec<String> {
        let mut kinds: Vec<String> = Vec::new();
        for path in &self.paths {
            let Ok(data) = fs::read(path) else { continue };
            let Ok(receipt) = serde_json::from_slice::<PlacementReceipt>(&data) else {
                log::warn!(
                    "ignoring an unreadable widget placement receipt: {}",
                    path.display()
                );
                continue;
            };
            if !receipt.counts_as_placed_at(now_unix) {
                log::debug!(
                    "widget placement receipt for {} is older than the freshness window",
                    receipt.kind
                );
                continue;
            }
            if !kinds.contains(&receipt.kind) {
                kinds.push(receipt.kind);
            }
        }
        kinds
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentgauge-placement-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch directory");
        dir
    }

    fn write_receipt(directory: &Path, file: &str, kind: &str, rendered_at: i64) {
        let receipt = PlacementReceipt {
            kind: kind.to_string(),
            rendered_at,
        };
        fs::write(
            directory.join(file),
            serde_json::to_vec(&receipt).expect("receipt encodes"),
        )
        .expect("receipt writes");
    }

    const NOW: i64 = 1_780_000_000;

    #[test]
    fn a_receipt_counts_until_it_ages_out() {
        let fresh = PlacementReceipt {
            kind: "AIStatsUsageWidget".to_string(),
            rendered_at: NOW - 60,
        };
        assert!(fresh.counts_as_placed_at(NOW));

        let just_inside = PlacementReceipt {
            kind: "AIStatsUsageWidget".to_string(),
            rendered_at: NOW - RECEIPT_MAX_AGE_SECS,
        };
        assert!(just_inside.counts_as_placed_at(NOW));

        let stale = PlacementReceipt {
            kind: "AIStatsUsageWidget".to_string(),
            rendered_at: NOW - RECEIPT_MAX_AGE_SECS - 1,
        };
        assert!(!stale.counts_as_placed_at(NOW));
    }

    #[test]
    fn a_receipt_from_the_future_is_not_trusted() {
        let small_skew = PlacementReceipt {
            kind: "AIStatsUsageWidget".to_string(),
            rendered_at: NOW + RECEIPT_MAX_FUTURE_SKEW_SECS,
        };
        assert!(small_skew.counts_as_placed_at(NOW));

        let clock_jumped = PlacementReceipt {
            kind: "AIStatsUsageWidget".to_string(),
            rendered_at: NOW + RECEIPT_MAX_FUTURE_SKEW_SECS + 1,
        };
        assert!(!clock_jumped.counts_as_placed_at(NOW));
    }

    #[test]
    fn both_builds_receipts_are_read_and_deduplicated() {
        let dir = scratch("both");
        write_receipt(
            &dir,
            RELEASE_RECEIPT_FILE_NAME,
            "AIStatsUsageWidget",
            NOW - 120,
        );
        write_receipt(
            &dir,
            DEV_RECEIPT_FILE_NAME,
            "AIStatsUsageWidgetDev",
            NOW - 240,
        );

        let store = PlacementReceiptStore::in_directory(&dir);
        let mut kinds = store.placed_kinds(NOW);
        kinds.sort();
        assert_eq!(kinds, vec!["AIStatsUsageWidget", "AIStatsUsageWidgetDev"]);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn one_builds_receipt_alone_is_evidence_for_the_other() {
        let dir = scratch("single");
        write_receipt(
            &dir,
            DEV_RECEIPT_FILE_NAME,
            "AIStatsUsageWidgetDev",
            NOW - 60,
        );

        let store = PlacementReceiptStore::in_directory(&dir);
        assert_eq!(store.placed_kinds(NOW), vec!["AIStatsUsageWidgetDev"]);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_stale_receipt_is_not_a_placement() {
        let dir = scratch("stale");
        write_receipt(
            &dir,
            DEV_RECEIPT_FILE_NAME,
            "AIStatsUsageWidgetDev",
            NOW - RECEIPT_MAX_AGE_SECS - 60,
        );

        assert!(PlacementReceiptStore::in_directory(&dir)
            .placed_kinds(NOW)
            .is_empty());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_corrupt_receipt_is_ignored_rather_than_fatal() {
        let dir = scratch("corrupt");
        fs::write(dir.join(DEV_RECEIPT_FILE_NAME), "{ not json").expect("writes");
        write_receipt(
            &dir,
            RELEASE_RECEIPT_FILE_NAME,
            "AIStatsUsageWidget",
            NOW - 30,
        );

        let store = PlacementReceiptStore::in_directory(&dir);
        assert_eq!(store.placed_kinds(NOW), vec!["AIStatsUsageWidget"]);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn no_receipts_means_no_placement() {
        let dir = scratch("empty");
        assert!(PlacementReceiptStore::in_directory(&dir)
            .placed_kinds(NOW)
            .is_empty());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_store_reads_the_snapshot_directory() {
        let store = PlacementReceiptStore::from_env().expect("a home directory in tests");
        let paths = store.paths();
        assert_eq!(paths.len(), 2);
        assert!(paths[0].ends_with(RELEASE_RECEIPT_FILE_NAME));
        assert!(paths[1].ends_with(DEV_RECEIPT_FILE_NAME));
        assert!(paths[0].parent() == paths[1].parent());
    }

    #[test]
    fn a_sandboxed_debug_build_ignores_the_real_profile() {
        // The e2e suite must not read the developer's own receipts: a widget
        // placed on this Mac would otherwise hide the setup action in a spec
        // that asserts the opposite.
        let dir = scratch("sandbox");
        write_receipt(
            &dir,
            DEV_RECEIPT_FILE_NAME,
            "AIStatsUsageWidgetDev",
            NOW - 60,
        );

        let sandboxed = PlacementReceiptStore::in_directory(&dir);
        assert_eq!(sandboxed.placed_kinds(NOW), vec!["AIStatsUsageWidgetDev"]);

        let empty = PlacementReceiptStore::in_directory(scratch("sandbox-empty"));
        assert!(empty.placed_kinds(NOW).is_empty());

        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(empty.paths()[0].parent().unwrap()).ok();
    }
}
