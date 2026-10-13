//! A widget request mailbox served by an on-demand, windowless launchd worker.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{now_secs, SnapshotStore, WidgetSnapshot};
use crate::modules::providers::ProviderRegistry;
use crate::shared::domain::{Freshness, ProviderKind, UsageSnapshot};
use crate::shared::error::Error;

#[cfg(debug_assertions)]
const REQUEST_FILE: &str = "widget-refresh-request-dev.json";
#[cfg(not(debug_assertions))]
const REQUEST_FILE: &str = "widget-refresh-request.json";

#[cfg(debug_assertions)]
const RESULT_FILE: &str = "widget-refresh-result-dev.json";
#[cfg(not(debug_assertions))]
const RESULT_FILE: &str = "widget-refresh-result.json";

#[cfg(debug_assertions)]
const SELECTION_FILE: &str = "widget-provider-selection-dev.txt";
#[cfg(not(debug_assertions))]
const SELECTION_FILE: &str = "widget-provider-selection.txt";

#[derive(Deserialize)]
struct Request {
    id: String,
    #[serde(rename = "requestedAt")]
    requested_at: Option<f64>,
}

#[derive(Serialize)]
struct ResultMessage<'a> {
    id: &'a str,
    state: &'a str,
}

fn directory() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("AGENTGAUGE_DATA_DIR") {
        return Some(PathBuf::from(dir));
    }
    let home = std::env::var_os("HOME")?;
    Some(crate::shared::app_support::app_support_dir(&home))
}

fn selected(snapshot: &WidgetSnapshot, directory: &Path) -> Option<ProviderKind> {
    let stored = fs::read_to_string(directory.join(SELECTION_FILE)).unwrap_or_default();
    snapshot
        .providers
        .iter()
        .find(|provider| provider.provider.as_str() == stored.trim())
        .or_else(|| snapshot.providers.first())
        .map(|provider| provider.provider)
}

fn service_request(
    store: &SnapshotStore,
    directory: &Path,
    read: &dyn Fn(ProviderKind) -> Result<UsageSnapshot, Error>,
) -> Result<(), Error> {
    let snapshot = store
        .read()?
        .ok_or_else(|| Error::storage("No synchronized widget subscriptions."))?;
    let kind = selected(&snapshot, directory)
        .ok_or_else(|| Error::storage("No synchronized widget subscriptions."))?;
    let usage = read(kind)?;
    if usage.freshness == Freshness::Unavailable {
        return Err(Error::provider_error(
            "The provider has no current reading.",
        ));
    }
    store.publish(&[usage], now_secs())
}

pub fn process_pending(registry: &ProviderRegistry) -> i32 {
    let Some(directory) = directory() else {
        return 1;
    };
    let request_path = directory.join(REQUEST_FILE);
    let Ok(bytes) = fs::read(&request_path) else {
        return 0;
    };
    let Ok(request) = serde_json::from_slice::<Request>(&bytes) else {
        return 0;
    };
    if request.id.len() != 36
        || !request
            .id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return 1;
    }
    let result_path = directory.join(RESULT_FILE);
    if fs::read(&result_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|result| {
            result
                .get("id")
                .and_then(|id| id.as_str())
                .map(str::to_owned)
        })
        .as_deref()
        == Some(request.id.as_str())
    {
        return 0;
    }
    if !request.requested_at.is_some_and(|at| {
        let age = now_secs() as f64 - at;
        (-5.0..=90.0).contains(&age)
    }) {
        return 0;
    }
    let Some(store) = SnapshotStore::from_env() else {
        return 1;
    };
    let state = if service_request(&store, &directory, &|kind| registry.usage(kind)).is_ok() {
        "success"
    } else {
        "failure"
    };
    let result = ResultMessage {
        id: &request.id,
        state,
    };
    if let Ok(bytes) = serde_json::to_vec(&result) {
        let temporary = result_path.with_extension(format!("{}.tmp", request.id));
        if fs::write(&temporary, bytes).is_ok() {
            let _ = fs::rename(&temporary, &result_path);
        }
        let _ = fs::remove_file(&temporary);
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_is_limited_to_providers_last_synchronized_by_the_app() {
        let directory =
            std::env::temp_dir().join(format!("widget-refresh-selection-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let snapshot = WidgetSnapshot {
            version: super::super::SNAPSHOT_VERSION,
            providers: vec![super::super::WidgetProviderSnapshot {
                provider: ProviderKind::Codex,
                display_name: "Codex".into(),
                generated_at: 0,
                plan: None,
                freshness: crate::shared::domain::Freshness::Live,
                reason: None,
                five_hour: None,
                weekly: None,
            }],
        };
        fs::write(directory.join(SELECTION_FILE), "zai").unwrap();
        assert_eq!(selected(&snapshot, &directory), Some(ProviderKind::Codex));
        fs::write(directory.join(SELECTION_FILE), "codex").unwrap();
        assert_eq!(selected(&snapshot, &directory), Some(ProviderKind::Codex));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn a_read_can_only_target_a_synchronized_provider() {
        let directory =
            std::env::temp_dir().join(format!("widget-refresh-read-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let store = SnapshotStore::at(directory.join("snapshot.json"));
        store
            .write(&WidgetSnapshot {
                version: super::super::SNAPSHOT_VERSION,
                providers: vec![super::super::WidgetProviderSnapshot {
                    provider: ProviderKind::Codex,
                    display_name: "Codex".into(),
                    generated_at: 0,
                    plan: None,
                    freshness: Freshness::Live,
                    reason: None,
                    five_hour: None,
                    weekly: None,
                }],
            })
            .unwrap();
        fs::write(directory.join(SELECTION_FILE), "zai").unwrap();
        let seen = std::cell::Cell::new(None);
        let result = service_request(&store, &directory, &|kind| {
            seen.set(Some(kind));
            Ok(UsageSnapshot::unavailable(kind, "not connected"))
        });
        assert_eq!(seen.get(), Some(ProviderKind::Codex));
        assert!(result.is_err());
        let _ = fs::remove_dir_all(directory);
    }
}
