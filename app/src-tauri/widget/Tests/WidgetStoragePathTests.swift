import Darwin
import Foundation

@main
struct WidgetStoragePathTests {
    static func main() {
        guard let account = getpwuid(getuid()), let directory = account.pointee.pw_dir else {
            fatalError("Could not resolve the account home directory")
        }

        let home = URL(fileURLWithPath: String(cString: directory), isDirectory: true)
        let expected = home.appendingPathComponent("Library/Application Support/AgentGauge", isDirectory: true)
        precondition(
            SnapshotStore.directoryURL.standardizedFileURL == expected.standardizedFileURL,
            "The sandboxed widget must read the host app's support directory, not its container"
        )
        let previous = home.appendingPathComponent("Library/Application Support/AI Sub Stats", isDirectory: true)
        precondition(
            SnapshotStore.previousDirectoryURL.standardizedFileURL == previous.standardizedFileURL,
            "The widget must read legacy migration input from the account home directory"
        )
        let placeholder = Snapshot.placeholder()
        precondition(
            placeholder.providers.allSatisfy { $0.fiveHour == nil && $0.weekly == nil && $0.isUnavailable },
            "A gallery placeholder must not present invented quotas as live usage"
        )
    }
}
