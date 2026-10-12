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
