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
reflects reality. The app re-reads the status every 10s while its window is
visible and again on focus, so a placement made in the gallery shows up without
refreshing.

To see what the query answered, run either app with `AGENTGAUGE_LOG_LEVEL=debug`
and read `~/Library/Application Support/<identifier>/logs/agentgauge-<date>.log`:
`widget configuration read: configured=… kinds=[…]` is the answer, and any
`widget status unknown: …` line names the failure — an unbundled binary, a
bridge that will not load, a truncated reply, or a query chronod never answered.

1. Open **AgentGauge Dev** once, then add it from the macOS widget gallery.
2. Small shows the brand mark and tight rows; medium shows provider plus
   side-by-side cards; large shows roomy stacked rows.
3. Click both arrows; confirm the provider and its 5-hour and weekly quotas
   change together.
4. Confirm unavailable quotas show no fabricated values.
5. Rebuild or refresh and confirm the widget updates when WidgetKit reloads it.
6. Confirm the sidebar's setup action appears within ~10s of removing the widget
   again, without pressing Refresh.

Gallery placement is manual. Timeline reloads are not immediate guarantees.
