import Foundation

@main
struct WidgetSnapshotTests {
    static func main() {
        func expect(_ condition: Bool, _ message: String) {
            guard condition else {
                FileHandle.standardError.write(
                    Data("WidgetSnapshotTests failed: \(message)\n".utf8)
                )
                exit(1)
            }
        }

        expect(Snapshot.supportedVersion == 3, "widget snapshot version must be 3")
        expect(Snapshot.ProviderKind.antigravity.displayName == "Antigravity", "displayName")
        expect(Snapshot.ProviderKind.antigravity.monogram == "A", "monogram")

        let v3Json = """
        {
          "version": 3,
          "providers": [
            {
              "provider": "codex",
              "displayName": "Codex",
              "generatedAt": 1700000000,
              "plan": "Team",
              "freshness": "live",
              "reason": null,
              "fiveHour": { "remainingPercent": 88, "resetsAt": 1700017760 },
              "weekly": { "remainingPercent": 46, "resetsAt": 1700345600 }
            },
            {
              "provider": "antigravity",
              "displayName": "Antigravity",
              "generatedAt": 1700000010,
              "plan": null,
              "freshness": "live",
              "reason": null,
              "fiveHour": null,
              "weekly": null,
              "quotaGroups": [
                {
                  "id": "gemini",
                  "displayName": "Gemini",
                  "fiveHour": { "remainingPercent": 100, "resetsAt": 1700018000 },
                  "weekly": { "remainingPercent": 75, "resetsAt": 1700600000 }
                },
                {
                  "id": "claude-gpt",
                  "displayName": "Claude & GPT",
                  "fiveHour": { "remainingPercent": 90, "resetsAt": 1700018500 },
                  "weekly": { "remainingPercent": 95, "resetsAt": 1700605000 }
                }
              ]
            }
          ]
        }
        """

        guard let v3Data = v3Json.data(using: .utf8),
              let decoded = try? JSONDecoder().decode(Snapshot.self, from: v3Data)
        else {
            FileHandle.standardError.write(
                Data("WidgetSnapshotTests failed: could not decode v3 snapshot with antigravity\n".utf8)
            )
            exit(1)
        }

        expect(decoded.isUsable, "v3 snapshot must be usable")
        expect(decoded.providers.count == 2, "expected 2 providers")
        expect(decoded.providers[0].quotaGroups.isEmpty, "codex has no quotaGroups")

        let agy = decoded.providers[1]
        expect(agy.provider == .antigravity, "expected antigravity provider")
        expect(agy.quotaGroups.count == 2, "expected 2 antigravity quotaGroups")
        expect(agy.quotaGroups[0].id == "gemini", "first group id")
        expect(agy.quotaGroups[0].displayName == "Gemini", "first group displayName")
        expect(agy.quotaGroups[0].weekly?.remainingPercent == 75, "gemini weekly")
        expect(agy.quotaGroups[1].id == "claude-gpt", "second group id")
        expect(agy.quotaGroups[1].fiveHour?.remainingPercent == 90, "claude-gpt 5h")
        expect(agy.allResetTimestamps.count == 4, "timeline provider sees all four reset timestamps")

        let v2Json = """
        {
          "version": 2,
          "providers": [
            {
              "provider": "codex",
              "displayName": "Codex",
              "generatedAt": 1700000000,
              "plan": "Team",
              "freshness": "live",
              "reason": null,
              "fiveHour": { "remainingPercent": 88, "resetsAt": 1700017760 },
              "weekly": { "remainingPercent": 46, "resetsAt": 1700345600 }
            }
          ]
        }
        """
        guard let v2Data = v2Json.data(using: .utf8),
              let v2Decoded = try? JSONDecoder().decode(Snapshot.self, from: v2Data)
        else {
            FileHandle.standardError.write(
                Data("WidgetSnapshotTests failed: could not decode v2 snapshot\n".utf8)
            )
            exit(1)
        }
        expect(v2Decoded.isUsable, "v2 snapshot upgrades to usable")
        expect(v2Decoded.providers[0].quotaGroups.isEmpty, "v2 has empty quotaGroups")

        let v99Json = #"{"version":99,"providers":[]}"#
        let v99Data = v99Json.data(using: .utf8)!
        expect((try? JSONDecoder().decode(Snapshot.self, from: v99Data)) == nil, "unknown version must fail")

        let groupSelectionFile = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("agentgauge-group-selection-\(UUID().uuidString).txt")
        defer { try? FileManager.default.removeItem(at: groupSelectionFile) }
        expect(
            QuotaGroupSelectionStore.selectedGroup(in: agy, from: groupSelectionFile)?.id == "gemini",
            "defaults to first group"
        )
        try! QuotaGroupSelectionStore.select(groupId: "claude-gpt", to: groupSelectionFile)
        expect(
            QuotaGroupSelectionStore.selectedGroup(in: agy, from: groupSelectionFile)?.id == "claude-gpt",
            "persists selected group"
        )

        print("WidgetSnapshotTests passed")
    }
}
