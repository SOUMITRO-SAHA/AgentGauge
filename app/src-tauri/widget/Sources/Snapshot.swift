import Foundation

/// The shared snapshot the host app writes and the widget reads.
///
/// This mirrors the JSON the Rust side emits in
/// `modules/widget/mod.rs`. Both sides are hand-maintained, so `snapshotVersion`
/// exists to fail loudly when one changes without the other: the widget refuses
/// to render a snapshot whose version it does not understand rather than showing
/// numbers that may no longer mean what they claim.
struct Snapshot: Decodable {
    /// Bumped whenever the wire shape changes. See `Snapshot.supportedVersion`.
    static let supportedVersion = 1

    let version: Int
    /// Unix seconds, written by the host app at read time.
    let generatedAt: Double
    let plan: String?
    /// One of `live`, `cached`, `stale`, `unavailable`.
    let freshness: String
    /// Why the reading is unavailable. Present only when `freshness` is
    /// `unavailable`.
    let reason: String?
    let windows: [Window]

    struct Window: Decodable {
        /// Which window this is, stated explicitly by the host app.
        ///
        /// Not inferred from `label`: the app's labels are short and
        /// provider-derived (`"5h"`, `"weekly"`), and matching on that text
        /// would let a cosmetic rename silently swap a 5-hour countdown for a
        /// weekly one.
        let kind: Kind
        let label: String
        /// Already expressed as *remaining*, matching the app's progress bars.
        /// The widget renders this number directly so it cannot be inverted.
        let remainingPercent: Int
        /// Unix seconds, or `nil` when the provider gave no reset time.
        let resetsAt: Double?
    }

    enum Kind: String, Decodable {
        case fiveHour
        case weekly
        case other
    }

    var isUsable: Bool { version == Self.supportedVersion }

    var isUnavailable: Bool { freshness == "unavailable" }

    var fiveHour: Window? { windows.first { $0.kind == .fiveHour } }

    var weekly: Window? { windows.first { $0.kind == .weekly } }

    /// Windows the host app reported but did not name. Rendered after the two
    /// known ones rather than dropped, so a provider that adds a window does not
    /// make it invisible.
    var other: [Window] { windows.filter { $0.kind == .other } }
}