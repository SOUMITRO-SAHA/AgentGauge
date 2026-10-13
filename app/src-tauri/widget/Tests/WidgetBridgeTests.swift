import Foundation

@main
struct WidgetBridgeTests {
    static func main() {
        var buffer = [CChar](repeating: 0, count: 96)
        let written = agentgauge_widget_status(
            kind: "AIStatsUsageWidget",
            out: &buffer,
            capacity: Int32(buffer.count)
        )
        precondition(written > 0, "the bridge must write a JSON answer")
        let json = String(cString: buffer)
        struct Reply: Decodable {
            let configured: Bool?
            let configuredKinds: [String]
        }
        let reply = try! JSONDecoder().decode(Reply.self, from: Data(json.utf8))
        precondition(
            reply.configured == true || reply.configured == false || reply.configured == nil,
            "configured must be true, false, or null, got: \(json)"
        )
        precondition(
            !reply.configuredKinds.isEmpty || reply.configured != true,
            "a configured kind must be listed, got: \(json)"
        )
        precondition(agentgauge_widget_reload(), "reload must complete")
    }
}
