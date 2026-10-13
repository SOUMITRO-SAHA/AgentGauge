import Foundation

#if DEBUG
private let widgetKind = "AIStatsUsageWidgetDev"
private let expectedFileName = "widget-placement-dev.json"
#else
private let widgetKind = "AIStatsUsageWidget"
private let expectedFileName = "widget-placement.json"
#endif

@main
struct PlacementReceiptTests {
    static func main() {
        func expect(_ condition: Bool, _ message: String) {
            guard condition else {
                FileHandle.standardError.write(
                    Data("PlacementReceiptTests failed: \(message)\n".utf8)
                )
                exit(1)
            }
        }

        let scratch = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("agentgauge-placement-receipt-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: scratch) }

        expect(
            PlacementReceipt.fileName == expectedFileName,
            "each build writes its own receipt file: expected \(expectedFileName), "
                + "got \(PlacementReceipt.fileName)"
        )
        expect(
            PlacementReceipt.fileURL.deletingLastPathComponent() == SnapshotStore.directoryURL,
            "the receipt must live beside the snapshot so both processes resolve one directory"
        )

        let renderedAt = Date(timeIntervalSince1970: 1_780_000_000)

        PlacementReceipt.recordIfRealRender(
            kind: widgetKind,
            isPreview: true,
            now: renderedAt,
            to: scratch
        )
        expect(
            PlacementReceipt.read(from: scratch) == nil,
            "a gallery preview is not a placement and must leave no receipt"
        )

        PlacementReceipt.recordIfRealRender(
            kind: widgetKind,
            isPreview: false,
            now: renderedAt,
            to: scratch
        )
        expect(
            PlacementReceipt.read(from: scratch)
                == PlacementReceipt.Receipt(
                    kind: widgetKind,
                    renderedAt: Int(renderedAt.timeIntervalSince1970)
                ),
            "a real render records the kind WidgetKit rendered and when, in whole seconds"
        )

        print("PlacementReceiptTests passed (\(PlacementReceipt.fileName))")
    }
}