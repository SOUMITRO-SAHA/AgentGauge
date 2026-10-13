import Darwin
import Foundation
import os

enum SnapshotStore {
#if DEBUG
    static let relativePath = "Library/Application Support/AgentGauge/widget-snapshot-dev.json"
    private static let previousRelativePath = "Library/Application Support/AI Sub Stats/widget-snapshot-dev.json"
#else
    static let relativePath = "Library/Application Support/AgentGauge/widget-snapshot.json"
    private static let previousRelativePath = "Library/Application Support/AI Sub Stats/widget-snapshot.json"
#endif

    fileprivate static let logger = Logger(
        subsystem: "com.soumitrasaha.agentgauge.widget",
        category: "snapshot"
    )

    private static var accountHomeDirectoryURL: URL {
        guard let account = getpwuid(getuid()), let directory = account.pointee.pw_dir else {
            logger.error("Could not resolve the account home directory for widget storage.")
            return FileManager.default.homeDirectoryForCurrentUser
        }
        return URL(fileURLWithPath: String(cString: directory), isDirectory: true)
    }

    static var directoryURL: URL {
        accountHomeDirectoryURL
            .appendingPathComponent(relativePath)
            .deletingLastPathComponent()
    }

    static var fileURL: URL {
        directoryURL.appendingPathComponent(URL(fileURLWithPath: relativePath).lastPathComponent)
    }

    static var previousDirectoryURL: URL {
        accountHomeDirectoryURL
            .appendingPathComponent(previousRelativePath)
            .deletingLastPathComponent()
    }

    static func read() -> Snapshot? {
        if let snapshot = decode(fileURL) {
            return snapshot
        }
        guard !FileManager.default.fileExists(atPath: fileURL.path) else { return nil }
        let previousURL = previousDirectoryURL.appendingPathComponent(
            URL(fileURLWithPath: previousRelativePath).lastPathComponent
        )
        guard let snapshot = decode(previousURL) else { return nil }
        persistMigration(snapshot)
        return snapshot
    }

    private static func decode(_ url: URL) -> Snapshot? {
        guard let data = try? Data(contentsOf: url),
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data),
              snapshot.isUsable else {
            return nil
        }
        return snapshot
    }

    private static func persistMigration(_ snapshot: Snapshot) {
        do {
            let data = try JSONEncoder().encode(snapshot)
            copyForward(data, to: fileURL)
        } catch {
            logger.error("Could not migrate the previous widget snapshot to AgentGauge storage.")
        }
    }

    static func copyForward(_ data: Data, to destination: URL) {
        let directory = destination.deletingLastPathComponent()
        let temporaryURL = directory.appendingPathComponent(
            ".\(destination.lastPathComponent)-\(UUID().uuidString).migration"
        )
        do {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true
            )
            defer { try? FileManager.default.removeItem(at: temporaryURL) }
            try data.write(to: temporaryURL, options: .atomic)
            try FileManager.default.linkItem(at: temporaryURL, to: destination)
        } catch {
            if !FileManager.default.fileExists(atPath: destination.path) {
                logger.error("Could not migrate previous data to AgentGauge storage.")
            }
        }
    }
}

enum ProviderSelectionStore {
#if DEBUG
    private static let fileName = "widget-provider-selection-dev.txt"
#else
    private static let fileName = "widget-provider-selection.txt"
#endif

    private static var fileURL: URL {
        SnapshotStore.directoryURL.appendingPathComponent(fileName)
    }

    static func selectedProvider(in snapshot: Snapshot) -> Snapshot.Provider? {
        let selected = storedSelection()
        return snapshot.providers.first { $0.provider.rawValue == selected }
            ?? snapshot.providers.first
    }

    private static func storedSelection() -> String? {
        if let current = try? String(contentsOf: fileURL, encoding: .utf8) {
            return current.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard let previous = try? Data(contentsOf: previousFileURL),
              let selected = String(data: previous, encoding: .utf8) else {
            return nil
        }
        SnapshotStore.copyForward(previous, to: fileURL)
        return selected.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static var previousFileURL: URL {
        SnapshotStore.previousDirectoryURL.appendingPathComponent(fileName)
    }

    static func advance(by offset: Int) throws {
        guard let snapshot = SnapshotStore.read(), !snapshot.providers.isEmpty else {
            throw ProviderSelectionError.noReading
        }
        let current = selectedProvider(in: snapshot) ?? snapshot.providers[0]
        let currentIndex = snapshot.providers.firstIndex { $0.provider == current.provider } ?? 0
        guard let nextIndex = ProviderCycler.nextIndex(
            currentIndex: currentIndex,
            offset: offset,
            count: snapshot.providers.count
        ) else {
            return
        }
        try FileManager.default.createDirectory(
            at: SnapshotStore.directoryURL,
            withIntermediateDirectories: true
        )
        try Data(snapshot.providers[nextIndex].provider.rawValue.utf8)
            .write(to: fileURL, options: .atomic)
    }
}

enum ProviderSelectionError: Error, LocalizedError {
    case noReading

    var errorDescription: String? {
        "No provider reading is available to switch to."
    }
}

/// The widget's own record that WidgetKit rendered it on this Mac.
///
/// `WidgetCenter.getCurrentConfigurations` answers only about the app that calls
/// it: chronod keys its configurations per containing app, so the Release build
/// cannot see a Debug widget and the Debug build cannot see a Release one. The
/// extension is the only process that runs for a placed widget, so what it
/// records here is the only cross-build evidence of a placement that macOS
/// offers. Every AgentGauge app reads these receipts to decide whether a widget
/// from any build is on this Mac.
enum PlacementReceipt {
#if DEBUG
    static let fileName = "widget-placement-dev.json"
#else
    static let fileName = "widget-placement.json"
#endif

    /// What the widget extension records and the host apps read back.
    struct Receipt: Codable {
        let kind: String
        let renderedAt: Int
    }

    private static let logger = Logger(
        subsystem: "com.soumitrasaha.agentgauge.widget",
        category: "placement"
    )

    static var fileURL: URL {
        SnapshotStore.directoryURL.appendingPathComponent(fileName)
    }

    /// Records the render, unless it was the widget gallery asking for a look.
    ///
    /// WidgetKit reports `isPreview` for gallery renders, and browsing the
    /// gallery is not a placement — recording one would tell every other build
    /// that a widget is on the Mac when none is.
    static func recordIfRealRender(
        kind: String,
        isPreview: Bool,
        now: Date = Date(),
        to url: URL = fileURL
    ) {
        guard !isPreview else { return }
        record(kind: kind, now: now, to: url)
    }

    /// Writes the receipt. Best effort: a receipt that cannot be written costs
    /// the other builds a cross-build answer, never the render, so a failure is
    /// logged and swallowed rather than thrown into the timeline callback.
    ///
    /// `url` defaults to the shared support directory. The parameter exists so
    /// the shape test can write to a scratch path instead of the user's own
    /// widget data.
    static func record(kind: String, now: Date = Date(), to url: URL = fileURL) {
        let receipt = Receipt(kind: kind, renderedAt: Int(now.timeIntervalSince1970))
        do {
            let data = try JSONEncoder().encode(receipt)
            try data.write(to: url, options: .atomic)
        } catch {
            logger.error("Could not record the widget placement receipt.")
        }
    }
}
