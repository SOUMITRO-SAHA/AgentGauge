import AppKit
import SwiftUI
import WidgetKit

/// The widget itself.
///
/// ## Families
///
/// Only the `system*` families are used. The `accessory*` families
/// (`accessoryCircular`, `accessoryRectangular`, `accessoryInline`) are marked
/// `@available(macOS, unavailable)` in the macOS SDK — they exist for iOS Lock
/// Screen and watchOS, not for the Mac. Verified against
/// `WidgetKit.swiftmodule/arm64e-apple-macos.swiftinterface` in the macOS 27
/// SDK.
///
/// So on macOS the choices are:
/// - `.systemSmall` / `.systemMedium` — desktop and Notification Center
/// - `.systemLarge` — desktop, when the user wants room for both windows in full
///
/// A menu-bar *Control* (`ControlWidgetButton`, macOS 26+) would be the way to
/// sit in the menu bar, but a Control is an action surface rather than a passive
/// readout, so it is deliberately not used here.
///
/// Every family shows the 5-hour window and the weekly limit. A widget that hid
/// one of them at small sizes would be worse than one that is merely denser.
struct UsageWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "AIStatsUsageWidget", provider: UsageTimelineProvider()) { entry in
            UsageWidgetView(entry: entry)
        }
        .configurationDisplayName("AgentGauge")
        .description("Your Codex 5-hour window and weekly limit.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct UsageWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: UsageEntry

    var body: some View {
        content
            // Required from macOS 14 onward. Without it the widget renders as a
            // bare, transparent rectangle.
            .containerBackground(for: .widget) {
                Color(nsColor: .windowBackgroundColor)
            }
            .widgetURL(URL(string: "agentgauge://usage"))
    }

    @ViewBuilder
    private var content: some View {
        if let snapshot = entry.snapshot {
            switch family {
            case .systemSmall:
                smallBody(snapshot)
            case .systemLarge:
                largeBody(snapshot)
            default:
                mediumBody(snapshot)
            }
        } else {
            missingBody
        }
    }

    // MARK: - Families

    /// The smallest desktop size. Both windows, stacked tightly.
    private func smallBody(_ snapshot: Snapshot) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            header(snapshot)
            if let fiveHour = snapshot.fiveHour {
                compactRow(fiveHour, title: "5-hour")
            }
            if let weekly = snapshot.weekly {
                compactRow(weekly, title: "Weekly")
            }
            ForEach(snapshot.other, id: \.label) { window in
                compactRow(window, title: window.label)
            }
            missingWindowsNotice(snapshot)
        }
    }

    /// The default desktop size. Room for a reset countdown per window.
    private func mediumBody(_ snapshot: Snapshot) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            header(snapshot)
            if let fiveHour = snapshot.fiveHour {
                detailedRow(fiveHour, "5-hour window")
            }
            if let weekly = snapshot.weekly {
                detailedRow(weekly, "Weekly limit")
            }
            ForEach(snapshot.other, id: \.label) { window in
                detailedRow(window, window.label)
            }
            missingWindowsNotice(snapshot)
        }
    }

    /// The large desktop size: the same two windows, given more room.
    private func largeBody(_ snapshot: Snapshot) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            header(snapshot)
            if let fiveHour = snapshot.fiveHour {
                detailedRow(fiveHour, "5-hour window")
            }
            if let weekly = snapshot.weekly {
                detailedRow(weekly, "Weekly limit")
            }
            ForEach(snapshot.other, id: \.label) { window in
                detailedRow(window, window.label)
            }
            missingWindowsNotice(snapshot)
            Spacer(minLength: 0)
            footer(snapshot)
        }
    }

    // MARK: - Pieces

    private func header(_ snapshot: Snapshot) -> some View {
        HStack(spacing: 5) {
            Text("Codex")
                .font(.caption2)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
            if let plan = snapshot.plan {
                Text(plan)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 0)
            freshnessDot(snapshot)
        }
    }

    /// Only rendered at large size, where there is room without crowding.
    private func footer(_ snapshot: Snapshot) -> some View {
        HStack(spacing: 4) {
            Text(snapshot.isUnavailable ? "Unavailable" : freshnessLabel(snapshot))
            Text("·")
            Text("updated \(Self.ageLabel(snapshot.generatedAt, now: entry.date))")
        }
        .font(.caption2)
        .foregroundStyle(.tertiary)
    }

    /// Shown only when the reading exists but carried no windows at all, so the
    /// widget says why rather than showing an empty frame.
    @ViewBuilder
    private func missingWindowsNotice(_ snapshot: Snapshot) -> some View {
        if snapshot.fiveHour == nil && snapshot.weekly == nil {
            Text(unavailableLabel(snapshot))
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Label and inline bar, with no countdown. Used at the small size.
    private func compactRow(_ window: Snapshot.Window, title: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text(title)
                    .font(.caption2)
                    .fontWeight(.medium)
                    .lineLimit(1)
                Spacer(minLength: 2)
                Text("\(window.remainingPercent)%")
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(tone(window.remainingPercent).color)
            }
            bar(window.remainingPercent)
        }
    }

    private func detailedRow(_ window: Snapshot.Window, _ title: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.caption)
                    .fontWeight(.medium)
                Spacer(minLength: 4)
                Text("\(window.remainingPercent)% left")
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(tone(window.remainingPercent).color)
            }
            bar(window.remainingPercent)
            Text(countdown(window.resetsAt))
                .font(.caption2)
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
    }

    private func bar(_ percent: Int) -> some View {
        // The incoming percentage is clamped before it reaches the width. A
        // provider reporting 101 or -3 must not push the row outside the widget
        // or ask for a negative-length capsule.
        let clamped = min(100, max(0, percent))
        return GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary)
                Capsule()
                    .fill(tone(percent).color)
                    .frame(width: geometry.size.width * CGFloat(clamped) / 100)
            }
        }
        .frame(height: 5)
    }

    private func freshnessDot(_ snapshot: Snapshot) -> some View {
        Circle()
            .fill(snapshot.isUnavailable ? Color.orange : Color.green)
            .frame(width: 5, height: 5)
            .accessibilityLabel(snapshot.isUnavailable ? "Unavailable" : freshnessLabel(snapshot))
    }

    private var missingBody: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("AgentGauge")
                .font(.caption2)
                .fontWeight(.semibold)
            Text("Open the app to read usage")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Formatting

    private func unavailableLabel(_ snapshot: Snapshot) -> String {
        snapshot.reason ?? "Usage unavailable"
    }

    private func freshnessLabel(_ snapshot: Snapshot) -> String {
        snapshot.freshness.capitalized
    }

    /// "Resets in 4h 58m".
    ///
    /// Past the reset time this reads "Resets now" rather than a negative
    /// duration, which would be the same fabrication as showing `0%`: the number
    /// would look like data while meaning nothing.
    private func countdown(_ resetsAt: Double?) -> String {
        guard let resetsAt else { return "Reset time unknown" }
        let remaining = resetsAt - Date().timeIntervalSince1970
        guard remaining > 0 else { return "Resets now" }

        let totalMinutes = Int(remaining / 60)
        let days = totalMinutes / 1440
        let hours = (totalMinutes % 1440) / 60
        let minutes = totalMinutes % 60

        if days > 0 {
            return "Resets in \(days)d \(hours)h"
        } else if hours > 0 {
            return "Resets in \(hours)h \(minutes)m"
        } else {
            return "Resets in \(minutes)m"
        }
    }

    /// Mirrors `toneFor()` in `src/lib/usage.ts`, which works in *used* percent:
    /// critical at 90% used, warning at 75%. Expressed here in *remaining*
    /// percent so the two surfaces cannot disagree about when a window is low.
    private func tone(_ remaining: Int) -> (color: Color, name: String) {
        switch remaining {
        case 26...:
            (Color.green, "healthy")
        case 11...25:
            (Color.orange, "warning")
        default:
            (Color.red, "critical")
        }
    }

    private static func ageLabel(_ generatedAt: Double, now: Date) -> String {
        let age = now.timeIntervalSince1970 - generatedAt
        // `generatedAt` is 0 in the gallery placeholder, where there is no real
        // reading and therefore no honest age to report.
        guard age > 0, age < 3600 else { return "recently" }
        let minutes = Int(age / 60)
        return minutes < 1 ? "just now" : "\(minutes)m ago"
    }
}

/// `@main` must be the bundle, so a second widget can be added later without
/// changing this file.
@main
struct AIStatsWidgetBundle: WidgetBundle {
    var body: some Widget {
        UsageWidget()
    }
}
