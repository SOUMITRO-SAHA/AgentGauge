import WidgetKit

struct UsageEntry: TimelineEntry {
    let date: Date
    let snapshot: Snapshot?
    let provider: Snapshot.Provider?
}

struct UsageTimelineProvider: TimelineProvider {
    static let maxAge: TimeInterval = 10 * 60
    static let retryAge: TimeInterval = 60

    func placeholder(in context: Context) -> UsageEntry {
        let snapshot = Snapshot.placeholder()
        return UsageEntry(date: Date(), snapshot: snapshot, provider: snapshot.providers.first)
    }

    func getSnapshot(in context: Context, completion: @escaping (UsageEntry) -> Void) {
        completion(makeEntry(date: Date(), snapshot: SnapshotStore.read()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<UsageEntry>) -> Void) {
        let now = Date()
        let entry = makeEntry(date: now, snapshot: SnapshotStore.read())
        let resets = [entry.provider?.fiveHour?.resetsAt, entry.provider?.weekly?.resetsAt]
            .compactMap { $0 }
            .filter { $0 > now.timeIntervalSince1970 }
            .map { Date(timeIntervalSince1970: $0) }
        let nextReset = resets.min()
        let age = entry.provider == nil || entry.provider?.isUnavailable == true
            ? Self.retryAge
            : Self.maxAge
        let refreshAt = [nextReset, now.addingTimeInterval(age)]
            .compactMap { $0 }
            .min() ?? now.addingTimeInterval(age)

        completion(Timeline(entries: [entry], policy: .after(refreshAt)))
    }

    private func makeEntry(date: Date, snapshot: Snapshot?) -> UsageEntry {
        UsageEntry(
            date: date,
            snapshot: snapshot,
            provider: snapshot.flatMap(ProviderSelectionStore.selectedProvider)
        )
    }
}
