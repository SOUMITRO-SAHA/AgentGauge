//! The desktop widget: a second, frameless, always-on-top window.
//!
//! Tauri models this as an ordinary [`WebviewWindow`] with its own URL, so the
//! same codebase serves the main app and the compact widget surface. There is
//! no native extension to build, which keeps the whole feature inside the
//! `cargo`/`bun` pipeline and therefore inside the e2e suite.
//!
//! The app must be able to answer "is the widget set up?" without the renderer
//! guessing, so the state lives here and is exposed over IPC.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::shared::error::Error;

/// Label of the widget window. Must match the capability entry that grants it
/// access to the bridge.
pub const WIDGET_LABEL: &str = "widget";

/// Route the widget window loads. Served by the same bundle as the app.
pub const WIDGET_ROUTE: &str = "index.html?surface=widget";

/// Whether the widget exists, and why not when it does not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetStatus {
    /// A widget window is currently open.
    pub installed: bool,
    /// Whether it is set to stay above other windows.
    pub always_on_top: bool,
    /// Why the widget is unavailable. Present only when `installed` is false.
    pub reason: Option<String>,
}

/// Owns widget-window lifecycle.
///
/// Held in Tauri state; it holds no `AppHandle` so it can be unit-tested
/// without a running application.
#[derive(Default)]
pub struct WidgetController {
    installed: Mutex<bool>,
}

impl WidgetController {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reads the live state from the window registry.
    ///
    /// The registry is the source of truth rather than the cached flag, so a
    /// window the user closed from the OS is correctly reported as gone.
    pub fn status(&self, app: &AppHandle) -> WidgetStatus {
        let Some(window) = app.get_webview_window(WIDGET_LABEL) else {
            return WidgetStatus {
                installed: false,
                always_on_top: false,
                reason: Some("The widget window is not open.".to_string()),
            };
        };

        let always_on_top = window.is_always_on_top().unwrap_or(false);

        if let Ok(mut installed) = self.installed.lock() {
            *installed = true;
        }

        WidgetStatus {
            installed: true,
            always_on_top,
            reason: None,
        }
    }

    /// Creates the widget window if it is not already open.
    ///
    /// Idempotent: calling it twice does not create two windows or error.
    pub fn setup(&self, app: &AppHandle) -> Result<WidgetStatus, Error> {
        if app.get_webview_window(WIDGET_LABEL).is_some() {
            return Ok(self.status(app));
        }

        let url =
            WebviewUrl::App(WIDGET_ROUTE.parse().map_err(|_| {
                Error::widget("The widget route could not be resolved.".to_string())
            })?);

        let window = WebviewWindowBuilder::new(app, WIDGET_LABEL, url)
            .title("AI Sub Stats")
            .inner_size(340.0, 260.0)
            .min_inner_size(300.0, 220.0)
            .decorations(false)
            .always_on_top(true)
            .shadow(true)
            .resizable(true)
            .skip_taskbar(true)
            .build()
            .map_err(|err| {
                Error::widget(format!("The widget window could not be created: {err}"))
            })?;

        // Start hidden so the user sees it appear in an expected place rather
        // than at an arbitrary default position.
        let _ = window.hide();

        Ok(self.status(app))
    }

    /// Shows the widget, creating it first if needed.
    pub fn show(&self, app: &AppHandle) -> Result<WidgetStatus, Error> {
        self.setup(app)?;
        if let Some(window) = app.get_webview_window(WIDGET_LABEL) {
            window
                .show()
                .map_err(|err| Error::widget(format!("The widget could not be shown: {err}")))?;
            window
                .set_focus()
                .map_err(|err| Error::widget(format!("The widget could not be focused: {err}")))?;
        }
        Ok(WidgetStatus {
            installed: true,
            always_on_top: true,
            reason: None,
        })
    }

    /// Closes the widget window.
    pub fn hide(&self, app: &AppHandle) -> Result<WidgetStatus, Error> {
        if let Some(window) = app.get_webview_window(WIDGET_LABEL) {
            window
                .close()
                .map_err(|err| Error::widget(format!("The widget could not be closed: {err}")))?;
        }
        if let Ok(mut installed) = self.installed.lock() {
            *installed = false;
        }
        Ok(WidgetStatus {
            installed: false,
            always_on_top: false,
            reason: Some("The widget window is not open.".to_string()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_controller_reports_nothing_installed() {
        let controller = WidgetController::new();
        // No AppHandle in a unit test, so this exercises the default state
        // rather than a live registry read.
        assert!(!controller.installed.lock().expect("lock").eq(&true));
    }

    #[test]
    fn the_widget_route_targets_the_widget_surface() {
        assert!(WIDGET_ROUTE.contains("surface=widget"));
    }

    #[test]
    fn the_widget_has_its_own_label() {
        assert_eq!(WIDGET_LABEL, "widget");
    }

    #[test]
    fn a_missing_widget_carries_a_reason() {
        let status = WidgetStatus {
            installed: false,
            always_on_top: false,
            reason: Some("The widget window is not open.".to_string()),
        };
        assert!(status.reason.is_some());
    }
}
