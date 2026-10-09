# The macOS system widget

A WidgetKit app extension. The user places it through the system widget gallery;
the system renders and schedules it. This replaces the previous version, which
opened a frameless always-on-top Tauri window that floated over whatever the user
was working in and could not be placed in the menu bar, Notification Center, or on
the desktop by macOS.

Only macOS is implemented. Other platforms report `supported: false` with a
reason.

## Building

```sh
cd app
bun run widget:build                      # build AIStatsWidget.appex
bunx tauri build --bundles app            # build the .app
bun run widget:embed path/to/App.app      # embed + re-sign
# or all three:
bun run build:mac
```

The extension **must** be built from a real Xcode app-extension target
(`com.apple.product-type.app-extension`).

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
and large; every one of them shows both the 5-hour window and the weekly limit.

A menu bar *Control* (`ControlWidgetButton`, macOS 26+) is the way to sit in the
menu bar, but a Control is an action surface rather than a passive readout, so it
is deliberately not used. The setup guide mentions the menu bar as an option
because on macOS 26+ it exists.

## How the two processes share data

The widget runs in a separate process managed by `chronod` and cannot read the
app's memory. The host app writes a JSON snapshot to a path both can reach:

```
~/Library/Application Support/AI Sub Stats/widget-snapshot.json
```

The write happens as a side effect of every usage read in
`modules/commands.rs::publish_snapshot`, so there is no sequence in which the app
is fresh and the widget is stale. It is atomic — written to a temp file and
renamed — because the widget may read the file at any moment, and a partial read
would be indistinguishable from "no data".

An App Group would be the production answer, but it has to be registered on the
developer portal first, and this build is ad-hoc signed, so no group container
exists. Both processes run as the same user and the extension is not sandboxed,
so the file path works. `Resources/AIStatsWidget.entitlements` explains this and is
deliberately empty.

The window list carries an explicit `kind` (`fiveHour` / `weekly` / `other`)
rather than a display label. The app's labels are short and provider-derived
(`"5h"`, `"weekly"`), and asking Swift to pattern-match on them would let a
cosmetic rename silently swap a 5-hour countdown for a weekly one.

`snapshot.version` guards the shape. The widget refuses to render a version it
does not recognise, so a mismatch shows as "no reading" rather than as numbers
that may no longer mean what they claim.

## What is verified, and what is not

Verified by running it on this machine (macOS 27.0, Xcode 27.0):

- the project builds, and `xcodebuild` emits an `.appex` with the correct
  `Info.plist` — matching a working system widget (`DockControls.appex`) field for
  field
- `codesign --verify --deep --strict` passes on the embedded bundle
- LaunchServices registers the host app and reports
  `plugin Identifiers: com.soumitrasaha.aism.widget`
- the Rust snapshot writer, and the agreement between the Rust JSON and the Swift
  `Snapshot` decoder

**Not verified:** that macOS lists the widget in the widget gallery.
`pluginkit -m -p com.apple.widgetkit-extension` does not list it, though it does
list 39 system widgets and at least one third-party widget. Unified logging was
unavailable (`log show` returns nothing in this environment), so the rejection
reason could not be read. The bundle is structurally identical to a working
system widget, so the likely causes are signing-related — an ad-hoc signature and
an unregistered App Group — rather than packaging.

To confirm by hand:

```sh
cd app
bun run build:mac
open "$(pwd)/src-tauri/target/release/bundle/macos/aism.app"
# then right-click the desktop -> Edit Widgets, and search for "AI Sub Stats"
```

If it is missing, check `codesign -dvvv --entitlements -` on the embedded
`.appex` and try signing with a real identity via `AISM_SIGN_IDENTITY`.

## Files

| Path | What it is |
| --- | --- |
| `AIStatsWidget.xcodeproj` | The app-extension target. Hand-written; no project generator is available or wanted. |
| `Sources/Snapshot.swift` | The wire contract. Mirrors `WidgetSnapshot` in `modules/widget/mod.rs`. |
| `Sources/SnapshotStore.swift` | Reads the shared file. |
| `Sources/UsageTimelineProvider.swift` | Refreshes at the soonest window reset. |
| `Sources/UsageWidget.swift` | The three families, and all the formatting. |
| `build-widget.sh` | Build, embed, re-sign, and the two build-time guards. |