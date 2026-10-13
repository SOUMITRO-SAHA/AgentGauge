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
        StaticConfiguration(kind: widgetKind, provider: UsageTimelineProvider(kind: widgetKind)) { entry in
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
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .containerBackground(.ultraThinMaterial, for: .widget)
            .widgetURL(URL(string: "agentgauge://usage"))
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .systemSmall: smallLayout
        case .systemMedium: mediumLayout
        default: largeLayout
        }
    }

    private var smallLayout: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 3) {
                WidgetBrandMark(size: 16)
                if entry.refreshFailed {
                    Image(systemName: "exclamationmark.circle")
                        .font(.system(size: 9))
                        .accessibilityLabel("Refresh failed; showing previous reading")
                }
                Text(entry.provider?.displayName ?? "")
                    .font(.system(size: 10, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                controls(compact: true)
            }
            compactRow("5-HOUR", quota: entry.provider?.fiveHour)
            compactRow("WEEKLY", quota: entry.provider?.weekly)
        }
    }

    private var mediumLayout: some View {
        VStack(alignment: .leading, spacing: 10) {
            header(showsProvider: true, markSize: 17)
            if entry.refreshing { refreshingLabel }
            if entry.refreshFailed { refreshFailure }
            HStack(spacing: 8) {
                cardRow("5-HOUR", quota: entry.provider?.fiveHour)
                cardRow("WEEKLY", quota: entry.provider?.weekly)
            }
        }
    }

    private var largeLayout: some View {
        GeometryReader { geometry in
            VStack(alignment: .leading, spacing: 9) {
                header(showsProvider: true, markSize: 18)
                if entry.refreshing { refreshingLabel }
                if entry.refreshFailed { refreshFailure }
                VStack(spacing: 8) {
                    detailedRow("5-HOUR", quota: entry.provider?.fiveHour)
                    detailedRow("WEEKLY", quota: entry.provider?.weekly)
                }
                .frame(maxHeight: .infinity)
                largeReadingDetails
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
    }

    private func header(showsProvider: Bool, markSize: CGFloat) -> some View {
        HStack(spacing: 10) {
            WidgetBrandMark(size: markSize)
            Spacer(minLength: 4)
            if showsProvider { providerCaption }
            controls(compact: false)
        }
    }

    private var refreshFailure: some View {
        Text("Refresh failed · showing previous reading")
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(.orange)
            .lineLimit(1)
    }

    private var refreshingLabel: some View {
        Text("Updating provider reading…")
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(.secondary)
    }

    @ViewBuilder
    private var providerCaption: some View {
        if let provider = entry.provider {
            HStack(spacing: 5) {
                Circle()
                    .fill(freshnessColor(provider.freshness))
                    .frame(width: 6, height: 6)
                Text(provider.displayName)
                    .font(.system(size: 11, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .foregroundStyle(.primary)
            }
            .accessibilityLabel(
                "\(provider.displayName), \(readingStatus(provider)), updated \(ageLabel(provider.generatedAt))"
            )
        }
    }

    private func controls(compact: Bool) -> some View {
        HStack(spacing: compact ? 3 : 6) {
            switchButton("chevron.left", offset: -1, label: "Previous provider", compact: compact)
            switchButton("chevron.right", offset: 1, label: "Next provider", compact: compact)
            refreshButton(compact: compact)
        }
    }

    private func switchButton(
        _ symbol: String,
        offset: Int,
        label: String,
        compact: Bool
    ) -> some View {
        Button(intent: SwitchProviderIntent(offset: offset)) {
            controlSymbol(symbol, compact: compact)
        }
        .buttonStyle(.plain)
        .disabled(!canSwitchProvider || entry.refreshing)
        .accessibilityLabel(label)
    }

    private func refreshButton(compact: Bool) -> some View {
        Button(intent: RefreshWidgetIntent()) {
            controlSymbol("arrow.clockwise", compact: compact)
        }
        .buttonStyle(.plain)
        .disabled(entry.refreshing)
        .accessibilityLabel("Refresh widget")
    }

    private func controlSymbol(_ symbol: String, compact: Bool) -> some View {
        Image(systemName: symbol)
            .font(.system(size: compact ? 9 : 11, weight: .semibold))
            .foregroundStyle(.primary.opacity(0.8))
            .frame(width: compact ? 20 : 25, height: compact ? 20 : 25)
            .background(.thinMaterial, in: Circle())
            .overlay {
                Circle().strokeBorder(.primary.opacity(0.12), lineWidth: 0.7)
            }
            .contentShape(Circle())
    }

    private func compactRow(_ title: String, quota: Snapshot.Provider.Quota?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                rowTitle(title, size: 9)
                Spacer(minLength: 1)
                percentText(quota, size: 17)
            }
            quotaBar(quota, height: 4)
            resetText(quota, size: 9)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 5)
        .background(quotaSurface)
        .accessibilityElement(children: .combine)
        .redacted(reason: entry.refreshing ? .placeholder : [])
        .invalidatableContent()
    }

    private func cardRow(_ title: String, quota: Snapshot.Provider.Quota?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                rowTitle(title, size: 10)
                Spacer(minLength: 2)
                percentText(quota, size: 24)
            }
            quotaBar(quota, height: 6)
            resetText(quota, size: 10)
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(quotaSurface)
        .accessibilityElement(children: .combine)
        .redacted(reason: entry.refreshing ? .placeholder : [])
        .invalidatableContent()
    }

    private func detailedRow(_ title: String, quota: Snapshot.Provider.Quota?) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                rowTitle(title, size: 11)
                Spacer(minLength: 4)
                percentText(quota, size: 30)
                if quota != nil {
                    Text("left")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
            }
            quotaBar(quota, height: 7)
            HStack {
                if let quota {
                    Text("\(usedPercent(quota))% used")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                resetText(quota, size: 11)
            }
            HStack(alignment: .firstTextBaseline) {
                metadataLabel("RESET DATE")
                Spacer(minLength: 4)
                if let resetsAt = quota?.resetsAt {
                    Text(Date(timeIntervalSince1970: resetsAt).formatted(.dateTime.month(.abbreviated).day().hour().minute()))
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.primary)
                } else {
                    Text("Not reported")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        .background(quotaSurface)
        .accessibilityElement(children: .combine)
        .redacted(reason: entry.refreshing ? .placeholder : [])
        .invalidatableContent()
    }

    private var largeReadingDetails: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    metadataLabel("READING STATUS")
                    Text(entry.provider.map(readingStatus) ?? "No reading")
                        .foregroundStyle(.primary)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 4) {
                    metadataLabel("LAST READ")
                    Text(entry.provider.map { ageLabel($0.generatedAt) } ?? "Unavailable")
                        .foregroundStyle(.primary)
                }
            }
            .font(.system(size: 11, weight: .medium))
            HStack(spacing: 5) {
                metadataLabel("PLAN")
                Text(entry.provider?.plan ?? "Plan not reported")
                    .lineLimit(1)
                Spacer(minLength: 4)
                metadataLabel("READ AT")
                Text(entry.provider.map {
                    Date(timeIntervalSince1970: $0.generatedAt).formatted(date: .omitted, time: .shortened)
                } ?? "—")
                    .monospacedDigit()
            }
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(.secondary)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(quotaSurface)
        .accessibilityElement(children: .combine)
    }

    private func usedPercent(_ quota: Snapshot.Provider.Quota) -> Int {
        100 - min(100, max(0, quota.remainingPercent))
    }

    private func metadataLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .bold, design: .rounded))
            .tracking(0.8)
            .foregroundStyle(.secondary)
    }

    private var quotaSurface: some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(.thinMaterial)
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(.primary.opacity(0.1), lineWidth: 0.7)
            }
    }

    private func rowTitle(_ title: String, size: CGFloat) -> some View {
        Text(title)
            .font(.system(size: size, weight: .bold, design: .rounded))
            .tracking(0.9)
            .foregroundStyle(.secondary)
    }

    @ViewBuilder
    private func percentText(_ quota: Snapshot.Provider.Quota?, size: CGFloat) -> some View {
        if let quota {
            Text("\(quota.remainingPercent)%")
                .font(.system(size: size, weight: .bold, design: .rounded))
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
            .minimumScaleFactor(0.8)
            .foregroundStyle(.secondary)
    }

    private func quotaBar(_ quota: Snapshot.Provider.Quota?, height: CGFloat) -> some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(.primary.opacity(0.12))
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
        .frame(height: height)
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
        if minutes < 1440 { return "\(minutes / 60)h ago" }
        return "\(minutes / 1440)d ago"
    }

    private func readingStatus(_ provider: Snapshot.Provider) -> String {
        switch provider.freshness {
        case "live": "Latest reading"
        case "cached": "Cached reading"
        case "stale": "Stale reading"
        default: "Unavailable"
        }
    }

    private func freshnessColor(_ freshness: String) -> Color {
        switch freshness {
        case "live": .green
        case "cached": .cyan
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
        weekly: Int?,
        refreshing: Bool = false,
        refreshFailed: Bool = false
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
        return UsageEntry(
            date: now,
            snapshot: snapshot,
            provider: providerSnapshot,
            refreshFailed: refreshFailed,
            refreshing: refreshing
        )
    }
}

#Preview("Small · live", as: .systemSmall) {
    UsageWidget()
} timeline: {
    WidgetPreviewFixtures.entry(provider: .codex, freshness: "live", fiveHour: 88, weekly: 46)
}

#Preview("Small · unavailable", as: .systemSmall) {
    UsageWidget()
} timeline: {
    WidgetPreviewFixtures.entry(provider: .kimi, freshness: "unavailable", fiveHour: nil, weekly: nil)
}

#Preview("Medium · stale", as: .systemMedium) {
    UsageWidget()
} timeline: {
    WidgetPreviewFixtures.entry(provider: .zai, freshness: "stale", fiveHour: 51, weekly: 42)
}

#Preview("Medium · cached", as: .systemMedium) {
    UsageWidget()
} timeline: {
    WidgetPreviewFixtures.entry(provider: .minimax, freshness: "cached", fiveHour: 27, weekly: 67)
}

#Preview("Medium · updating", as: .systemMedium) {
    UsageWidget()
} timeline: {
    WidgetPreviewFixtures.entry(provider: .codex, freshness: "cached", fiveHour: 78, weekly: 97, refreshing: true)
}

#Preview("Large · live", as: .systemLarge) {
    UsageWidget()
} timeline: {
    WidgetPreviewFixtures.entry(provider: .codex, freshness: "live", fiveHour: 85, weekly: 98)
}

#Preview("Large · no reading", as: .systemLarge) {
    UsageWidget()
} timeline: {
    WidgetPreviewFixtures.entry(provider: .kimi, freshness: "unavailable", fiveHour: nil, weekly: nil)
}

#Preview("Large · refresh failed", as: .systemLarge) {
    UsageWidget()
} timeline: {
    WidgetPreviewFixtures.entry(provider: .zai, freshness: "stale", fiveHour: 49, weekly: 65, refreshFailed: true)
}

@main
struct AIStatsWidgetBundle: WidgetBundle {
    var body: some Widget {
        UsageWidget()
    }
}
