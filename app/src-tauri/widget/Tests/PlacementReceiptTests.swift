import Foundation

#if DEBUG
private let widgetKind = "AIStatsUsageWidgetDev"
private let expectedFileName = "widget-placement-dev.json"
#else
private let widgetKind = "AIStatsUsageWidget"
private let expectedFileName = "widget-placement.json"
#endif

/// The receipt as the host app's Rust reader expects to find it.
///
/// Decoded independently of the writer's own type, so the assertion is about the
/// bytes on disk — the contract between the two processes — rather than about a
/// round trip through the same struct on both sides.
private struct StoredReceipt: Decodable {
    let kind: String
    let renderedAt: Int
}

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
            !FileManager.default.fileExists(atPath: scratch.path),
            "a gallery preview is not a placement and must leave no receipt"
        )

        PlacementReceipt.recordIfRealRender(
            kind: widgetKind,
            isPreview: false,
            now: renderedAt,
            to: scratch
        )
        guard let data = try? Data(contentsOf: scratch),
              let stored = try? JSONDecoder().decode(StoredReceipt.self, from: data)
        else {
            FileHandle.standardError.write(
                Data("PlacementReceiptTests failed: a real render must write a decodable receipt\n".utf8)
            )
            exit(1)
        }
        expect(stored.kind == widgetKind, "the receipt names the kind WidgetKit rendered")
        expect(
            stored.renderedAt == Int(renderedAt.timeIntervalSince1970),
            "the receipt carries the render time in whole Unix seconds, as the host reader parses it"
        )

        print("PlacementReceiptTests passed (\(PlacementReceipt.fileName))")
    }
}
