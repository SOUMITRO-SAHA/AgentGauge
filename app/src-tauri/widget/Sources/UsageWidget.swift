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

/// The AgentGauge A-mark, redrawn as a vector path so the extension needs no
/// asset catalog. Same geometry as the sidebar's `BrandMark`.
struct BrandMarkShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 256, y: 64))
        path.addLine(to: CGPoint(x: 456, y: 432))
        path.addLine(to: CGPoint(x: 344, y: 432))
        path.addLine(to: CGPoint(x: 256, y: 300))
        path.addLine(to: CGPoint(x: 168, y: 432))
        path.addLine(to: CGPoint(x: 56, y: 432))
        path.closeSubpath()
        path.move(to: CGPoint(x: 256, y: 145))
        path.addLine(to: CGPoint(x: 322, y: 300))
        path.addLine(to: CGPoint(x: 190, y: 300))
        path.closeSubpath()
        let scale = min(rect.width, rect.height) / 512
        return path.applying(CGAffineTransform(scaleX: scale, y: scale))
    }
}

struct WidgetBrandMark: View {
    var size: CGFloat

    var body: some View {
        BrandMarkShape()
            .fill(.primary, style: FillStyle(eoFill: true))
            .frame(width: size, height: size)
            .accessibilityLabel("AgentGauge")
    }
}

struct UsageWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: UsageEntry

    private var canSwitchProvider: Bool {
        (entry.snapshot?.providers.count ?? 0) > 1
    }

    var body: some View {
        content
            .containerBackground(for: .widget) {
                Color(nsColor: .windowBackgroundColor)
            }
            .widgetURL(URL(string: "agentgauge://usage"))
    }

    // One layout per family: a small widget cannot fit the full header above
    // two comfortable quota rows — that overflow is what pushed the old header
    // outside the container background — so each size gets its own density.
    @ViewBuilder
    private var content: some View {
        switch family {
        case .systemSmall: smallLayout
        case .systemMedium: mediumLayout
        default: largeLayout
        }
    }

    // MARK: Small — brand mark only, tight stacked rows.

    private var smallLayout: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 4) {
                WidgetBrandMark(size: 12)
                Spacer(minLength: 4)
                arrows(compact: true)
            }
            compactRow("5-HOUR", quota: entry.provider?.fiveHour)
            compactRow("WEEKLY", quota: entry.provider?.weekly)
        }
    }

    // MARK: Medium — brand mark, provider line, cards side by side.

    private var mediumLayout: some View {
        VStack(alignment: .leading, spacing: 9) {
            header(showsProvider: true, markSize: 13)
            HStack(alignment: .top, spacing: 8) {
                cardRow("5-HOUR", quota: entry.provider?.fiveHour)
                cardRow("WEEKLY", quota: entry.provider?.weekly)
            }
        }
    }

    // MARK: Large — roomy stacked rows.

    private var largeLayout: some View {
        VStack(alignment: .leading, spacing: 11) {
            header(showsProvider: true, markSize: 14)
            detailedRow("5-hour", quota: entry.provider?.fiveHour)
            detailedRow("Weekly", quota: entry.provider?.weekly)
        }
    }

    private func header(showsProvider: Bool, markSize: CGFloat) -> some View {
        HStack(spacing: 6) {
            WidgetBrandMark(size: markSize)
            Spacer(minLength: 4)
            if showsProvider {
                providerCaption
            }
            arrows(compact: false)
        }
    }

    @ViewBuilder
    private var providerCaption: some View {
        if let provider = entry.provider {
            HStack(spacing: 4) {
                Circle()
                    .fill(freshnessColor(provider.freshness))
                    .frame(width: 5, height: 5)
                Text(provider.displayName)
                    .font(.caption2.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .foregroundStyle(.secondary)
            }
            .accessibilityLabel(
                "\(provider.displayName), \(provider.freshness), updated \(ageLabel(provider.generatedAt))"
            )
        }
    }

    private func arrows(compact: Bool) -> some View {
        HStack(spacing: 3) {
            switchButton("chevron.left", offset: -1, label: "Previous provider", compact: compact)
            switchButton("chevron.right", offset: 1, label: "Next provider", compact: compact)
        }
    }

    private func switchButton(
        _ symbol: String,
        offset: Int,
        label: String,
        compact: Bool
    ) -> some View {
        Button(intent: SwitchProviderIntent(offset: offset)) {
            Image(systemName: symbol)
                .font(.system(size: compact ? 8 : 9, weight: .bold))
                .foregroundStyle(.secondary)
                .frame(width: compact ? 20 : 23, height: compact ? 20 : 23)
                .background(Color.primary.opacity(0.06), in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!canSwitchProvider)
        .accessibilityLabel(label)
    }

    private func compactRow(_ title: String, quota: Snapshot.Provider.Quota?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                rowTitle(title, size: 8, tracking: 0.6)
                Spacer(minLength: 4)
                percentText(quota, size: 15)
            }
            quotaBar(quota)
            resetText(quota, size: 8)
        }
        .padding(8)
        .background(
            Color.primary.opacity(0.035),
            in: RoundedRectangle(cornerRadius: 9, style: .continuous)
        )
        .accessibilityElement(children: .combine)
    }

    private func cardRow(_ title: String, quota: Snapshot.Provider.Quota?) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                rowTitle(title, size: 9, tracking: 0.7)
                Spacer(minLength: 4)
                percentText(quota, size: 17)
            }
            quotaBar(quota)
            resetText(quota, size: 9)
        }
        .padding(9)
        .background(
            Color.primary.opacity(0.035),
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
        .accessibilityElement(children: .combine)
    }

    private func detailedRow(_ title: String, quota: Snapshot.Provider.Quota?) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                rowTitle(title, size: 9, tracking: 0.8)
                Spacer(minLength: 4)
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    percentText(quota, size: 20)
                    if quota != nil {
                        Text("left")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            quotaBar(quota)

            HStack(spacing: 4) {
                Image(systemName: quota == nil ? "minus.circle" : "arrow.clockwise")
                    .font(.system(size: 8, weight: .medium))
                resetText(quota, size: 9)
                    .padding(0)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background(
            Color.primary.opacity(0.035),
            in: RoundedRectangle(cornerRadius: 11, style: .continuous)
        )
        .accessibilityElement(children: .combine)
    }

    private func rowTitle(_ title: String, size: CGFloat, tracking: CGFloat) -> some View {
        Text(title)
            .font(.system(size: size, weight: .bold, design: .rounded))
            .tracking(tracking)
            .foregroundStyle(.secondary)
    }

    @ViewBuilder
    private func percentText(_ quota: Snapshot.Provider.Quota?, size: CGFloat) -> some View {
        if let quota {
            Text("\(quota.remainingPercent)%")
                .font(.system(size: size, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(quotaColor(quota.remainingPercent))
        } else {
            Text("—")
                .font(.system(size: size, weight: .semibold, design: .rounded))
                .foregroundStyle(.tertiary)
        }
    }

    private func resetText(_ quota: Snapshot.Provider.Quota?, size: CGFloat) -> some View {
        Text(resetDescription(quota))
            .font(.system(size: size, weight: .medium, design: .rounded))
            .lineLimit(1)
            .foregroundStyle(.tertiary)
    }

    private func quotaBar(_ quota: Snapshot.Provider.Quota?) -> some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.08))
                if let quota {
                    Capsule()
                        .fill(quotaColor(quota.remainingPercent))
                        .frame(
                            width: geometry.size.width
                                * CGFloat(min(100, max(0, quota.remainingPercent))) / 100
                        )
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
