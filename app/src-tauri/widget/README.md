# The macOS system widget

A WidgetKit app extension. The user places it through the system widget gallery;
the system renders and schedules it. This replaces the previous version, which
opened a frameless always-on-top Tauri window that floated over whatever the user
was working in and could not be placed in the menu bar, Notification Center, or on
the desktop by macOS.

Only macOS is implemented. Other platforms report `supported: false` with a
reason.

For concise development and verification steps, see
[the widget testing guide](../../../docs/widget-testing.md).

## Building

```sh
cd app
bun run widget:build                      # build the extension and status reader
bunx tauri build --bundles app            # build the .app
bun run widget:embed path/to/App.app      # embed + re-sign
# or all three:
bun run build:mac
```

The extension **must** be built from a real Xcode app-extension target
(`com.apple.product-type.app-extension`).

## Widget UI development

Open `AIStatsWidget.xcodeproj` in Xcode and use the SwiftUI canvas previews in
`Sources/UsageWidget.swift` to review small, medium, and large families with
live, stale, and unavailable readings. Preview fixtures are static; they never
read or overwrite a real account snapshot.

For an installed development widget, run:

```sh
cd app
bun run widget:dev
```

This builds a debug `.app` with a separate `AgentGauge Dev` bundle identifier,
builds and embeds the Debug extension, and watches the widget Swift sources and
Rust snapshot producers. Swift changes rebuild/re-embed the extension and
request a timeline refresh. Rust changes rebuild and relaunch only the dev app.
The dev widget uses a separate snapshot and provider-selection file, and its
widget kind and extension identifier are distinct from the release build.

Place **AgentGauge Dev** manually from the macOS widget gallery once. The
gallery placement cannot be automated by the app, and a timeline reload is a
request to WidgetKit—not a guarantee of immediate rendering. This loop targets
the native widget only; normal frontend UI development still uses `tauri dev`.

## Three traps, all verified on this machine

### 1. A SwiftPM executable wrapped in a `.appex` does not work

`AIStatsWidget.xcodeproj` exists rather than a `Package.swift` because
hand-wrapping a plain Swift executable into an `.appex` produces an extension
that registers and then immediately exits. `WidgetBundle.main()` returns instead
of blocking, so the process leaves its post-main epilogue without ever entering an
XPC runloop. Traced to a three-frame `exit()` in dyld on macOS 26; it worked on
macOS 14/15, where the runloop was set up for it.

This is [steipete/CodexBar#1095](https://github.com/steipete/CodexBar/issues/1095),
and its fix is the one used here. **Do not "simplify" this into a SwiftPM target.**

Two more things from that issue are enforced by `build-widget.sh` at build time,
so a future edit cannot quietly reintroduce them:

- `CFBundlePackageType` must be `XPC!`
- `NSExtensionPrincipalClass` must **not** be set — it crashes `_EXRunningExtension`
  with `Unrecognized extension type`

### 2. The certificate's CN is not the Team ID

An Apple Development certificate's CN ends in the Apple ID in brackets, not the
Team ID. On this machine CN says `(DW5S8RN36T)` while the Team ID is the OU field,
`N4W9KXP57T`. Reading the CN suffix produces an entitlements mismatch that macOS
rejects. The real ID comes from:

```sh
security find-certificate -c "Apple Development: …" -p | openssl x509 -noout -subject
```

### 3. macOS has no `accessory*` widget families

`accessoryCircular`, `accessoryRectangular`, `accessoryInline` and
`accessoryCorner` are all marked `@available(macOS, unavailable)` in the macOS
SDK. They are iOS Lock Screen and watchOS families. Verified in
`WidgetKit.swiftmodule/arm64e-apple-macos.swiftinterface`:

```swift
@available(iOS 16.0, watchOS 9.0, visionOS 27.0, *)
@available(macOS, unavailable)
case accessoryRectangular
```

macOS therefore offers only `systemSmall`, `systemMedium`, `systemLarge`,
`systemExtraLarge`, and `systemExtraLargePortrait`. The widget uses small, medium
and large; every one shows the selected provider's 5-hour and weekly quota.
The header's accessible left/right buttons cycle through providers with a
current or cached quota reading.

A menu bar _Control_ (`ControlWidgetButton`, macOS 26+) is the way to sit in the
menu bar, but a Control is an action surface rather than a passive readout, so it
is deliberately not used. The setup guide mentions the menu bar as an option
because on macOS 26+ it exists.

## How the two processes share data

The widget runs in a separate process managed by `chronod` and cannot read the
app's memory. The host app writes a JSON snapshot to a path both can reach:

```
~/Library/Application Support/AgentGauge/widget-snapshot.json
```

The write happens as a side effect of every usage read in
`modules/commands.rs::publish_snapshot`. Provider readings are merged so a
single-provider refresh does not erase the other providers. A failed refresh
keeps the last known quota marked stale; unconnected providers without a reading
are omitted. Concurrent usage reads serialize their read/merge/write steps
inside the app. Writes are atomic — written to a unique temp file and renamed — because
the widget may read at any moment, and a partial read could look like "no data".

The extension is sandboxed as macOS requires. Until a developer team can
provision an App Group, `Resources/AIStatsWidget.entitlements` grants it
read/write access only to the AgentGauge support directory and read-only access
to the previous product directory for migration. These macOS temporary
exceptions are a development/distribution constraint, not a substitute for a
registered App Group in a Mac App Store release.
The extension resolves the login account's home via `getpwuid`; a sandboxed
process's `FileManager.homeDirectoryForCurrentUser` resolves to its private
container and cannot find the host's snapshot. A signed sandbox regression test
checks both paths during every widget build.

The wire payload identifies each provider explicitly and carries only named
`fiveHour` and `weekly` quota fields; arbitrary provider windows are not
forwarded to the widget. `snapshot.version` guards the shape. The widget refuses
to render a version it does not recognise, so a mismatch shows as "no reading"
rather than numbers that may no longer mean what they claim.

The extension persists the selected provider in a sibling selection file. An
App Intent changes that selection and requests a reload of the widget timeline;
it does not make a provider request or spend quota. Release data uses
`~/Library/Application Support/AgentGauge/widget-snapshot.json` and
`widget-provider-selection.txt`; debug data uses `widget-snapshot-dev.json` and
`widget-provider-selection-dev.txt` in that same directory. On upgrade, the
host and widget copy old snapshot and selection files forward from the previous
`AI Sub Stats` directory; the old files are retained, and all new writes use
`AgentGauge`.

## Detecting user configuration

The app calls `WidgetCenter.getCurrentConfigurations` **in its own process** by
loading the bundled `Contents/Frameworks/libWidgetBridge.dylib` with `dlopen`
(once, then kept — polling must not `dlclose` an image a WidgetKit reply may
still be running in). `chronod` accepts WidgetCenter calls only from the process
whose executable is the bundle's `CFBundleExecutable`, so a spawned helper
executable is rejected — that was the bug that kept configuration "unknown"
forever. The bridge answers `configured` for the requested kind plus
`configuredKinds`, the list of configured AgentGauge widget kinds; a missing or
failed query is `null` and means unknown, never "not configured". The same
bridge carries `reloadAllTimelines`, which the app requests after every snapshot
publication; a rejected or absent bridge degrades to WidgetKit's own refresh
cadence. This reports configuration, not whether the widget is on the desktop or
in Notification Center. The host app cannot add the widget or open the gallery
for the user, so setup actions navigate to the in-app instructions instead.

Two facts about the system shape everything above:

- **The query is per app bundle.** WidgetKit answers with the kinds configured
  for the calling app, so a Debug placement is invisible to Release and vice
  versa. `configuredKinds` therefore normally holds only this build's own kinds;
  it still carries whatever the system reports, so the UI stays correct if the
  scoping ever widens.
- **Only a bundled app can ask.** `tauri dev` and the e2e harness run the bare
  binary, with no `.app` to hold the extension or the bridge: there
  `extension_present` is false, no query happens, and the status is unknown.
  Detection therefore needs `bun run build:mac`, and the Settings panel says so
  rather than reporting the widget as absent.

## Keeping detection live

Placement happens in the system's gallery, where the app cannot follow it, and
WidgetKit offers no subscription. `useSystemWidgetStatusPolling`
(`app/src/hooks/use-system-widget-status.ts`) re-reads the status every 10s
while the window is visible, on window focus, and when the window returns from
hidden, so a widget added or removed shows up without a manual refresh. A hidden
window stops asking. `shouldOfferWidgetSetup` stands down only on positive
confirmation — the affordance stays reachable when the query is unknown or the
build cannot ask, because hiding the only route to the setup steps is how a user
ends up unable to add the widget at all.

## What is verified, and what is not

Verified by running it on this machine (macOS 27.0, Xcode 27.0):

- the project builds, and `xcodebuild` emits an `.appex` with the correct
  `Info.plist` — matching a working system widget (`DockControls.appex`) field for
  field
- `codesign --verify --deep --strict` passes on the embedded bundle
- LaunchServices registers the host app and reports
  `plugin Identifiers: com.soumitrasaha.agentgauge.widget`
- the Rust snapshot writer, and the agreement between the Rust JSON and the Swift
  `Snapshot` decoder

The previous build was not listed by PlugInKit because the extension was
re-signed without entitlements and its target explicitly disabled App Sandbox.
The build now tests the signed extension's sandbox and storage entitlements.
The rebuilt Debug extension is listed by PlugInKit. The local WidgetCenter
helper still returns unknown, and gallery placement/provider interaction still
require manual confirmation on the target Mac.

To confirm by hand:

```sh
cd app
bun run build:mac
open "$(pwd)/src-tauri/target/release/bundle/macos/AgentGauge.app"
# then right-click the desktop -> Edit Widgets, and search for "AgentGauge"
```

If it is missing, check `codesign -dvvv --entitlements -` on the embedded
`.appex` and try signing with a real identity via `AGENTGAUGE_SIGN_IDENTITY`.

## Files

| Path                                  | What it is                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `AIStatsWidget.xcodeproj`             | The app-extension target. Hand-written; no project generator is available or wanted. |
| `Sources/Snapshot.swift`              | The wire contract. Mirrors `WidgetSnapshot` in `modules/widget/mod.rs`.              |
| `Sources/SnapshotStore.swift`         | Reads the shared file.                                                               |
| `Sources/UsageTimelineProvider.swift` | Reads the selected provider and refreshes at the soonest quota reset.                |
| `Sources/UsageWidget.swift`           | Per-family layouts (small: brand-only compact, medium: side-by-side cards, large: roomy rows) and the Xcode preview matrix. |
| `Sources/ProviderSwitchIntent.swift`  | Cycles providers without opening the host app.                                       |
| `Sources/WidgetBridge.swift`          | In-process WidgetKit status query and timeline reload, built as `libWidgetBridge.dylib`. |
| `build-widget.sh`                     | Build, embed, re-sign, and the two build-time guards.                                |
| `app/scripts/widget-dev.ts`            | Isolated debug app and native widget rebuild watcher.                                |
