import AppIntents
import Foundation
import WidgetKit

#if DEBUG
private let widgetKind = "AIStatsUsageWidgetDev"
#else
private let widgetKind = "AIStatsUsageWidget"
#endif

struct RefreshWidgetIntent: AppIntent {
    static var title: LocalizedStringResource = "Refresh AgentGauge widget"

    func perform() async throws -> some IntentResult {
        let request = WidgetRefreshRequest(id: UUID().uuidString.lowercased(), requestedAt: Date().timeIntervalSince1970)
        do {
            try FileManager.default.createDirectory(
                at: SnapshotStore.directoryURL,
                withIntermediateDirectories: true
            )
            try JSONEncoder().encode(request).write(to: WidgetRefreshRequest.requestURL, options: .atomic)
            WidgetCenter.shared.reloadTimelines(ofKind: widgetKind)
            for _ in 0..<100 {
                try await Task.sleep(for: .milliseconds(500))
                if let result = WidgetRefreshRequest.result(), result.id == request.id {
                    WidgetCenter.shared.reloadTimelines(ofKind: widgetKind)
                    return .result()
                }
            }
            try WidgetRefreshRequest(id: request.id, state: "failure")
                .writeResult()
        } catch {
            try? WidgetRefreshRequest(id: request.id, state: "failure").writeResult()
        }
        WidgetCenter.shared.reloadTimelines(ofKind: widgetKind)
        return .result()
    }
}

struct WidgetRefreshRequest: Codable {
    let id: String
    var requestedAt: TimeInterval? = nil
    var state: String? = nil

#if DEBUG
    private static let suffix = "-dev"
#else
    private static let suffix = ""
#endif

    static var requestURL: URL {
        SnapshotStore.directoryURL.appendingPathComponent("widget-refresh-request\(suffix).json")
    }

    private static var resultURL: URL {
        SnapshotStore.directoryURL.appendingPathComponent("widget-refresh-result\(suffix).json")
    }

    static func result() -> Self? {
        guard let data = try? Data(contentsOf: resultURL) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }

    static var isPending: Bool {
        guard let data = try? Data(contentsOf: requestURL),
              let request = try? JSONDecoder().decode(Self.self, from: data) else {
            return false
        }
        return request.id != result()?.id
    }

    func writeResult() throws {
        try JSONEncoder().encode(self).write(to: Self.resultURL, options: .atomic)
    }
}
