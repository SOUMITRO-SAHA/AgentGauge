import WidgetKit

/// One rendered moment of usage data.
struct UsageEntry: TimelineEntry {
    let date: Date
    let snapshot: Snapshot?
}

/// Feeds the widget from the snapshot file the host app writes.
///
/// WidgetKit timelines are cached by `chronod`, so this is a poll, not a
/// subscription. The refresh cadence is chosen to line up with the thing the
/// user actually cares about: when a window resets.
struct UsageTimelineProvider: TimelineProvider {
    /// Widgets stay fresh without the user re-adding them, but there is no
    /// upper bound on how long `chronod` may hold a timeline, so this is a
    /// refresh request rather than a guarantee.
    static let maxAge: TimeInterval = 10 * 60

    /// A failed or missing reading is retried sooner, because it is the state
    /// most likely to have changed: the host app may be mid-refresh.
    static let retryAge: TimeInterval = 60

    func placeholder(in context: Context) -> UsageEntry {
        UsageEntry(date: Date(), snapshot: SnapshotStore.placeholder())
    }

    func getSnapshot(in context: Context, completion: @escaping (UsageEntry) -> Void) {
        completion(UsageEntry(date: Date(), snapshot: SnapshotStore.read()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<UsageEntry>) -> Void) {
        let now = Date()
        let snapshot = SnapshotStore.read()
        let entry = UsageEntry(date: now, snapshot: snapshot)

        // Refresh when the soonest window resets, so the countdown does not
        // tick past zero and sit there showing a stale value.
        var resets: [Double] = []
        if let snapshot {
            if let fiveHour = snapshot.fiveHour?.resetsAt { resets.append(fiveHour) }
            if let weekly = snapshot.weekly?.resetsAt { resets.append(weekly) }
        }
        let nextReset = resets
            .filter { $0 > now.timeIntervalSince1970 }
            .map { Date(timeIntervalSince1970: $0) }
            .min()

        let age = snapshot == nil || snapshot?.isUnavailable == true
            ? Self.retryAge
            : Self.maxAge

        let candidates = [nextReset, now.addingTimeInterval(age)].compactMap { $0 }
        let refreshAt = candidates.min() ?? now.addingTimeInterval(age)

        completion(Timeline(entries: [entry], policy: .after(refreshAt)))
    }
}