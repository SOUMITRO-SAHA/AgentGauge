# Widget development and testing

Requires macOS and Xcode.

## Develop

```sh
cd app
bun run widget:dev
```

This builds and launches the isolated **AgentGauge Dev** app, registers its
sandboxed widget extension with LaunchServices, and watches Swift and Rust
widget sources. Stop the watcher with `Ctrl-C`.

For previews, open `app/src-tauri/widget/AIStatsWidget.xcodeproj` and
`app/src-tauri/widget/Sources/UsageWidget.swift`.

## Build and automated checks

```sh
cd app
bun run widget:build
AGENTGAUGE_WIDGET_CONFIGURATION=Debug bun run widget:build
bun run build:mac
bun run e2e --spec ./e2e/specs/features/widget-setup.e2e.ts
```

The widget build checks provider cycling, sandboxed storage paths, and the
extension bundle. The e2e spec covers the app's setup guide, not native widget
rendering.

`widget:build` does **not** install the new UI into the placed widget. For the
Release widget, `bun run build:mac` builds and embeds the extension in the
packaged app; launch that app and request Refresh in the widget. For an isolated
Dev placement, `bun run widget:dev` builds, embeds, and opens AgentGauge Dev.
If an already-running watcher misses a Swift file change, rerun it to rebuild
and embed; a successful Xcode build by itself cannot change a placed widget.
macOS controls the actual redraw timing and may keep an old rendered timeline.

## Check the native widget

The app queries WidgetCenter **in-process** through
`Contents/Frameworks/libWidgetBridge.dylib`; there is no helper executable to
run by hand — a spawned helper is rejected by chronod. Verify the loop instead:

```sh
cd app
pluginkit -m -p com.apple.widgetkit-extension -i com.soumitrasaha.agentgauge.widgetdev.widget

/usr/bin/log show --last 5m --style compact \
  --predicate 'process == "chronod" AND eventMessage CONTAINS "AIStatsUsageWidgetDev"' \
  | grep -iE "reload|render"
```

A `reload: begin` … `Reload success` pair right after the app launches or
publishes a reading means the app → bridge → chronod → extension loop works.

Detection is per build and only possible from a bundled app. `bun run tauri dev`
and the e2e harness run a bare binary with no `.app` to hold the extension or the
bridge, so the status is unknown there by construction — use `bun run build:mac`
(or the Dev app) when checking whether the sidebar's "Set up widget" action
reflects reality. The app re-reads the status every 10s while it is open and again
on focus, so a placement made in the gallery shows up without refreshing.

WidgetCenter answers per containing app, so a Release app cannot see a widget the
Debug build placed. The extension therefore records a placement receipt beside the
snapshot on every non-gallery render, and every build reads them:

```sh
cat ~/Library/Application\ Support/AgentGauge/widget-placement*.json
```

A receipt written within the last 12 hours means that widget is on the Mac, and
the setup action stays hidden whichever build placed it. Remove the widget and the
receipt goes stale within the window, because macOS stops rendering it.

To see what the query answered, run either app with `AGENTGAUGE_LOG_LEVEL=debug`
and read `~/Library/Application Support/<identifier>/logs/agentgauge-<date>.log`:
`widget configuration read: configured=… kinds=[…]` is the answer, and any
`widget status unknown: …` line names the failure — an unbundled binary, a
bridge that will not load, a truncated reply, or a query chronod never answered.

1. Open **AgentGauge Dev** once, then add it from the macOS widget gallery.
2. Small shows the provider name and both quotas without clipping; medium shows
   side-by-side quota cards; large fills its height with remaining and used
   percentages, reset countdowns and calendar dates, reading status, last-read
   age and time, and plan or “Plan not reported”. There must be no horizontal
   header rule. Check each size against a light and dark desktop background for
   material translucency and text legibility. macOS may adapt widget material to
   the system's appearance and accessibility settings.
3. Click both arrows; confirm the provider and its 5-hour and weekly quotas
    change together.
4. Click Refresh; confirm the pending state redacts quotas, then the selected
   provider's reading updates with a new last-read time. Quit the app window and
   repeat: the on-demand headless AgentGauge worker performs the read without
   reopening the window. If the provider is unreachable, the prior reading
   remains visible with “Refresh failed”, not a fresh timestamp. The widget's
   sandbox should still have no CLI or network access. WidgetKit may skip an
   intermediate loading frame or delay a redraw; it does not offer a guaranteed
   continuous animation while an App Intent is running.
5. Confirm unavailable quotas show no fabricated values.
6. Rebuild or refresh and confirm the widget updates when WidgetKit reloads it.
7. Confirm the sidebar's setup action appears within ~10s of removing the widget
    again, without pressing Refresh.
8. With only the Dev widget placed, open the packaged Release app: it must report
    the Dev widget as on this Mac and keep the setup action hidden.

Gallery placement is manual. Timeline reloads are not immediate guarantees.
