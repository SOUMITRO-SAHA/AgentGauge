import Foundation

/// Reads the snapshot the host app writes.
///
/// The file lives in the user's `Application Support` directory rather than in
/// an App Group container. Both processes run as the same user, and both are
/// unsigned by App Sandbox (see `AIStatsWidget.entitlements`), so a plain path
/// works without the developer-portal App Group registration that a sandboxed
/// build would require.
enum SnapshotStore {
    /// Must match `SNAPSHOT_RELATIVE_PATH` in `modules/widget/mod.rs` in the
    /// Rust backend.
    static let relativePath = "Library/Application Support/AI Sub Stats/widget-snapshot.json"

    static var fileURL: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(relativePath)
    }

    /// Reads the snapshot, or `nil` when it is absent, unreadable, or written
    /// by a version this widget does not understand.
    ///
    /// Returning `nil` for all three cases is deliberate: the widget renders a
    /// single "no reading yet" state rather than guessing at partial data.
    static func read() -> Snapshot? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        guard let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) else {
            return nil
        }
        return snapshot.isUsable ? snapshot : nil
    }

    /// A placeholder shown in the widget gallery, before any real data exists.
    ///
    /// It carries plausible numbers on purpose — the gallery has no access to the
    /// host app — but it is only ever used as a redacted stand-in, never as a
    /// real reading.
    static func placeholder() -> Snapshot {
        Snapshot(
            version: Snapshot.supportedVersion,
            generatedAt: 0,
            plan: "Team",
            freshness: "live",
            reason: nil,
            windows: [
                .init(kind: .fiveHour, label: "5h", remainingPercent: 88, resetsAt: nil),
                .init(kind: .weekly, label: "weekly", remainingPercent: 46, resetsAt: nil),
            ]
        )
    }
}