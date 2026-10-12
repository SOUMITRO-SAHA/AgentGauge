import Dispatch
import Foundation
import WidgetKit

@main
struct WidgetStatusReader {
    static func main() {
        let argument = CommandLine.arguments.dropFirst().first ?? ""
        if argument == "--reload" {
            WidgetCenter.shared.reloadAllTimelines()
            exit(EXIT_SUCCESS)
        }

        let kind = argument
        WidgetCenter.shared.getCurrentConfigurations { result in
            switch result {
            case .success(let widgets):
                writeResult(widgets.contains { $0.kind == kind })
                exit(EXIT_SUCCESS)
            case .failure:
                writeResult(nil)
                exit(EXIT_FAILURE)
            }
        }
        dispatchMain()
    }

    private static func writeResult(_ configured: Bool?) {
        let value = configured.map { $0 ? "true" : "false" } ?? "null"
        let json = "{\"configured\":\(value)}\n"
        FileHandle.standardOutput.write(Data(json.utf8))
    }
}
