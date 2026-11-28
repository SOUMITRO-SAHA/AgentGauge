import AppIntents
import WidgetKit

#if DEBUG
private let widgetKind = "AIStatsUsageWidgetDev"
#else
private let widgetKind = "AIStatsUsageWidget"
#endif

struct SwitchProviderIntent: AppIntent {
    static var title: LocalizedStringResource = "Switch AgentGauge provider"

    @Parameter(title: "Direction")
    var offset: Int

    init() {
        offset = 1
    }

    init(offset: Int) {
        self.offset = offset
    }

    func perform() async throws -> some IntentResult {
        try ProviderSelectionStore.advance(by: offset)
        WidgetCenter.shared.reloadTimelines(ofKind: widgetKind)
        return .result()
    }
}

struct SelectQuotaGroupIntent: AppIntent {
    static var title: LocalizedStringResource = "Select Antigravity model group"

    @Parameter(title: "Group")
    var groupId: String

    init() {
        groupId = ""
    }

    init(groupId: String) {
        self.groupId = groupId
    }

    func perform() async throws -> some IntentResult {
        try QuotaGroupSelectionStore.select(groupId: groupId)
        WidgetCenter.shared.reloadTimelines(ofKind: widgetKind)
        return .result()
    }
}
