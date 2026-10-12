import Foundation

struct Snapshot: Codable {
    static let supportedVersion = 2

    let version: Int
    let providers: [Provider]

    private enum CodingKeys: String, CodingKey {
        case version
        case providers
    }

    init(version: Int, providers: [Provider]) {
        self.version = version
        self.providers = providers
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let version = try container.decode(Int.self, forKey: .version)
        if version == Self.supportedVersion {
            self.version = version
            providers = try container.decode([Provider].self, forKey: .providers)
            return
        }
        guard version == 1 else {
            throw DecodingError.dataCorruptedError(
                forKey: .version,
                in: container,
                debugDescription: "Unsupported widget snapshot version"
            )
        }

        let previous = try LegacySnapshot(from: decoder)
        var fiveHour: Provider.Quota?
        var weekly: Provider.Quota?
        for window in previous.windows {
            let quota = Provider.Quota(
                remainingPercent: window.remainingPercent,
                resetsAt: window.resetsAt
            )
            switch window.kind {
            case .fiveHour: fiveHour = quota
            case .weekly: weekly = quota
            case .other: break
            }
        }
        self.version = Self.supportedVersion
        providers = [
            Provider(
                provider: .codex,
                displayName: "Codex",
                generatedAt: previous.generatedAt,
                plan: previous.plan,
                freshness: previous.freshness,
                reason: previous.reason,
                fiveHour: fiveHour,
                weekly: weekly
            ),
        ]
    }

    struct Provider: Codable, Identifiable {
        let provider: ProviderKind
        let displayName: String
        let generatedAt: Double
        let plan: String?
        let freshness: String
        let reason: String?
        let fiveHour: Quota?
        let weekly: Quota?

        var id: ProviderKind { provider }
        var isUnavailable: Bool { freshness == "unavailable" }

        struct Quota: Codable {
            let remainingPercent: Int
            let resetsAt: Double?
        }
    }

    enum ProviderKind: String, Codable, CaseIterable, Identifiable {
        case codex
        case zai
        case minimax
        case kimi

        var id: String { rawValue }

        var displayName: String {
            switch self {
            case .codex: "Codex"
            case .zai: "Z.AI"
            case .minimax: "MiniMax"
            case .kimi: "Kimi"
            }
        }

        var monogram: String {
            switch self {
            case .codex: "C"
            case .zai: "Z"
            case .minimax: "M"
            case .kimi: "K"
            }
        }
    }

    var isUsable: Bool { version == Self.supportedVersion }

    static func placeholder(now: Date = Date()) -> Self {
        let provider = Provider(
            provider: .codex,
            displayName: "Codex",
            generatedAt: now.timeIntervalSince1970,
            plan: nil,
            freshness: "unavailable",
            reason: "Open AgentGauge to read usage.",
            fiveHour: nil,
            weekly: nil
        )
        return Self(version: supportedVersion, providers: [provider])
    }
}

private struct LegacySnapshot: Decodable {
    let version: Int
    let generatedAt: Double
    let plan: String?
    let freshness: String
    let reason: String?
    let windows: [LegacyWindow]
}

private struct LegacyWindow: Decodable {
    let kind: Kind
    let remainingPercent: Int
    let resetsAt: Double?

    enum Kind: String, Decodable {
        case fiveHour
        case weekly
        case other
    }
}
