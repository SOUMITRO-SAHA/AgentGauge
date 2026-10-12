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

Run the packaged WidgetCenter query:

```sh
cd app
"./src-tauri/target/debug/bundle/macos/AgentGauge Widget Dev.app/Contents/MacOS/AgentGaugeWidgetStatus" AIStatsUsageWidgetDev
```

`configured` is `true`, `false`, or `null` when the system query is unavailable.
On this machine PlugInKit confirms registration, while the WidgetCenter helper
still returns `null`; that is unknown setup state, not a registration failure.
Confirm PlugInKit sees the extension before opening the gallery:

```sh
pluginkit -m -p com.apple.widgetkit-extension -i com.soumitrasaha.agentgauge.widgetdev.widget
```

1. Open **AgentGauge Dev** once, then add it from the macOS widget gallery.
2. Click both arrows; confirm the provider and its 5-hour and weekly quotas
   change together.
3. Confirm unavailable quotas show no fabricated values.
4. Rebuild or refresh and confirm the widget updates when WidgetKit reloads it.

Gallery placement is manual. Timeline reloads are not immediate guarantees.
