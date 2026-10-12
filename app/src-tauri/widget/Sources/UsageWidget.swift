import SwiftUI
import WidgetKit

#if DEBUG
private let widgetKind = "AIStatsUsageWidgetDev"
private let widgetDisplayName = "AgentGauge Dev"
#else
private let widgetKind = "AIStatsUsageWidget"
private let widgetDisplayName = "AgentGauge"
#endif

struct UsageWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: widgetKind, provider: UsageTimelineProvider()) { entry in
            UsageWidgetView(entry: entry)
        }
        .configurationDisplayName(widgetDisplayName)
        .description("Switch providers and check 5-hour and weekly quota.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct UsageWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: UsageEntry

    private var canSwitchProvider: Bool {
        (entry.snapshot?.providers.count ?? 0) > 1
    }

    var body: some View {
        VStack(alignment: .leading, spacing: family == .systemSmall ? 8 : 10) {
            header
            quotaRow("5-hour", quota: entry.provider?.fiveHour)
            quotaRow("Weekly", quota: entry.provider?.weekly)
        }
        .containerBackground(for: .widget) {
            Color(nsColor: .windowBackgroundColor)
        }
        .widgetURL(URL(string: "agentgauge://usage"))
    }

    private var header: some View {
        HStack(spacing: 7) {
            if let provider = entry.provider {
                ZStack(alignment: .bottomTrailing) {
                    Text(provider.provider.monogram)
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.accentColor)
                        .frame(width: 22, height: 22)
                        .background(Color.accentColor.opacity(0.12), in: Circle())
                    Circle()
                        .fill(freshnessColor(provider.freshness))
                        .frame(width: 6, height: 6)
                        .overlay(Circle().stroke(Color(nsColor: .windowBackgroundColor), lineWidth: 1))
                }
                .accessibilityLabel(
                    "\(provider.displayName), \(provider.freshness), updated \(ageLabel(provider.generatedAt))"
                )
                Text(provider.displayName)
                    .font(.system(.subheadline, design: .rounded, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            } else {
                Image(systemName: "gauge.with.dots.needle.67percent")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                Text("AgentGauge")
                    .font(.system(.subheadline, design: .rounded, weight: .semibold))
                    .lineLimit(1)
            }

            Spacer(minLength: 2)

            HStack(spacing: 3) {
                switchButton("chevron.left", offset: -1, label: "Previous provider")
                switchButton("chevron.right", offset: 1, label: "Next provider")
            }
        }
    }

    private func switchButton(_ symbol: String, offset: Int, label: String) -> some View {
        Button(intent: SwitchProviderIntent(offset: offset)) {
            Image(systemName: symbol)
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(.secondary)
                .frame(width: 23, height: 23)
                .background(Color.primary.opacity(0.06), in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!canSwitchProvider)
        .accessibilityLabel(label)
    }

    private func quotaRow(_ title: String, quota: Snapshot.Provider.Quota?) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(title.uppercased())
                    .font(.system(size: 9, weight: .bold, design: .rounded))
                    .tracking(0.8)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 4)
                if let quota {
                    HStack(alignment: .firstTextBaseline, spacing: 3) {
                        Text("\(quota.remainingPercent)%")
                            .font(.system(.title3, design: .rounded, weight: .semibold))
                            .monospacedDigit()
                            .foregroundStyle(quotaColor(quota.remainingPercent))
                        Text("left")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Text("—")
                        .font(.system(.title3, design: .rounded, weight: .semibold))
                        .foregroundStyle(.tertiary)
                }
            }

            quotaBar(quota)

            HStack(spacing: 4) {
                Image(systemName: quota == nil ? "minus.circle" : "arrow.clockwise")
                    .font(.system(size: 8, weight: .medium))
                Text(resetDescription(quota))
                    .font(.system(size: 9, weight: .medium, design: .rounded))
                    .lineLimit(1)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, family == .systemSmall ? 7 : 9)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private func quotaBar(_ quota: Snapshot.Provider.Quota?) -> some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.08))
                if let quota {
                    Capsule()
                        .fill(quotaColor(quota.remainingPercent))
                        .frame(width: geometry.size.width * CGFloat(min(100, max(0, quota.remainingPercent))) / 100)
                }
            }
        }
        .frame(height: 5)
        .accessibilityHidden(true)
    }

    private func resetDescription(_ quota: Snapshot.Provider.Quota?) -> String {
        guard let quota else {
            return entry.provider?.isUnavailable == true ? "Usage unavailable" : "No reading yet"
        }
        guard let resetsAt = quota.resetsAt else { return "Reset time unavailable" }

        let seconds = resetsAt - entry.date.timeIntervalSince1970
        guard seconds > 0 else { return "Resets now" }

        let minutes = Int(seconds / 60)
        let days = minutes / 1440
        let hours = (minutes % 1440) / 60
        let remainder = minutes % 60
        if days > 0 { return "Resets in \(days)d \(hours)h" }
        if hours > 0 { return "Resets in \(hours)h \(remainder)m" }
        return "Resets in \(remainder)m"
    }

    private func ageLabel(_ generatedAt: Double) -> String {
        let minutes = max(0, Int((entry.date.timeIntervalSince1970 - generatedAt) / 60))
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes)m ago" }
        return "\(minutes / 60)h ago"
    }

    private func freshnessColor(_ freshness: String) -> Color {
        switch freshness {
        case "live": .green
        case "cached": .blue
        default: .orange
        }
    }

    private func quotaColor(_ remaining: Int) -> Color {
        switch remaining {
        case 26...: .green
        case 11...25: .orange
        default: .red
        }
    }
}

private enum WidgetPreviewFixtures {
    static let now = Date()

    static func entry(
        provider: Snapshot.ProviderKind,
        freshness: String,
        fiveHour: Int?,
        weekly: Int?
    ) -> UsageEntry {
        let providerSnapshot = Snapshot.Provider(
            provider: provider,
            displayName: provider.displayName,
            generatedAt: now.addingTimeInterval(freshness == "stale" ? -420 : 0).timeIntervalSince1970,
            plan: nil,
            freshness: freshness,
            reason: freshness == "unavailable" ? "No reading is available." : nil,
            fiveHour: fiveHour.map {
                .init(remainingPercent: $0, resetsAt: now.addingTimeInterval(17_760).timeIntervalSince1970)
            },
            weekly: weekly.map {
                .init(remainingPercent: $0, resetsAt: now.addingTimeInterval(345_600).timeIntervalSince1970)
            }
        )
        let snapshot = Snapshot(version: Snapshot.supportedVersion, providers: [providerSnapshot])
        return UsageEntry(date: now, snapshot: snapshot, provider: providerSnapshot)
    }
}

#Preview("Small · Codex", as: .systemSmall) {
    UsageWidget()
} timeline: {
    WidgetPreviewFixtures.entry(provider: .codex, freshness: "live", fiveHour: 88, weekly: 46)
}

#Preview("Medium · Z.AI", as: .systemMedium) {
    UsageWidget()
} timeline: {
    WidgetPreviewFixtures.entry(provider: .zai, freshness: "stale", fiveHour: 51, weekly: 42)
}

#Preview("Large · no reading", as: .systemLarge) {
    UsageWidget()
} timeline: {
    WidgetPreviewFixtures.entry(provider: .kimi, freshness: "unavailable", fiveHour: nil, weekly: nil)
}

@main
struct AIStatsWidgetBundle: WidgetBundle {
    var body: some Widget {
        UsageWidget()
    }
}
