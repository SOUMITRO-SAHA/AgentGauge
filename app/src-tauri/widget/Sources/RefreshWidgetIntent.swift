import AppIntents
import WidgetKit

#if DEBUG
private let widgetKind = "AIStatsUsageWidgetDev"
#else
private let widgetKind = "AIStatsUsageWidget"
#endif

struct RefreshWidgetIntent: AppIntent {
    static var title: LocalizedStringResource = "Refresh AgentGauge widget"

    func perform() async throws -> some IntentResult {
        WidgetCenter.shared.reloadTimelines(ofKind: widgetKind)
        return .result()
    }
}
