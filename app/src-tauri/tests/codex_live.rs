//! Integration coverage for the Codex transport against a real CLI.
//!
//! These tests spawn the installed `codex` binary, so they assert the wire
//! contract end to end rather than against a fixture. They are skipped when
//! the CLI is absent, which keeps the suite green on a machine without it
//! without pretending the transport was verified.
//!
//! Run with:
//!
//! ```sh
//! cargo test --manifest-path app/src-tauri/Cargo.toml --test codex_live
//! ```

use std::time::Duration;

/// Spawns the app-server and returns it, or `None` when Codex is not installed.
fn server() -> Option<aism_lib::testkit::AppServer> {
    let server = aism_lib::testkit::AppServer::spawn("codex").ok()?;
    Some(server)
}

#[test]
fn reads_the_real_rate_limit_payload() {
    let Some(server) = server() else {
        eprintln!("skipping: the codex CLI is not installed");
        return;
    };

    let payload = server
        .request(
            "account/rateLimits/read",
            Some(serde_json::json!({ "excludeResetCreditDetails": true })),
        )
        .expect("the app-server answers a rate-limit read");

    // Assert on the shape, not the values: what matters is that the keys this
    // decoder depends on are really present in a live response.
    let value: serde_json::Value = serde_json::from_str(&payload).expect("valid JSON");
    assert!(
        value.get("rateLimits").is_some(),
        "expected a rateLimits object, got {payload}"
    );
}

#[test]
fn decodes_a_live_rate_limit_response() {
    let Some(server) = server() else {
        eprintln!("skipping: the codex CLI is not installed");
        return;
    };

    let payload = server
        .request(
            "account/rateLimits/read",
            Some(serde_json::json!({ "excludeResetCreditDetails": true })),
        )
        .expect("the app-server answers a rate-limit read");

    let snapshot =
        aism_lib::testkit::decode_rate_limits(&payload, aism_lib::testkit::ProviderKind::Codex, 0)
            .expect("decodes");

    // A real account always reports at least one window. Asserting this means
    // the decode is proven against live data, while staying independent of the
    // particular values on this machine.
    assert!(
        !snapshot.windows.is_empty(),
        "expected at least one usage window from a live account"
    );
    for window in &snapshot.windows {
        assert!(
            (0..=100).contains(&window.used_percent),
            "used_percent out of range: {}",
            window.used_percent
        );
        assert_eq!(
            window.remaining_percent,
            100 - window.used_percent,
            "used and remaining must agree"
        );
    }
}

#[test]
fn rejects_a_second_initialize() {
    let Some(server) = server() else {
        eprintln!("skipping: the codex CLI is not installed");
        return;
    };

    // The handshake happens during `spawn`, so a second one must fail. This
    // pins the "one initialize per process" contract the transport relies on.
    let err = server
        .request(
            "initialize",
            Some(serde_json::json!({
                "clientInfo": { "name": "ism", "title": "AI Sub Stats", "version": "0.1.0" }
            })),
        )
        .expect_err("a second initialize must be refused");

    assert_eq!(err.kind.as_str(), "providerError");
}

#[test]
fn reports_a_typed_error_for_an_unknown_method() {
    let Some(server) = server() else {
        eprintln!("skipping: the codex CLI is not installed");
        return;
    };

    let err = server
        .request("account/definitelyNotAMethod", Some(serde_json::json!({})))
        .expect_err("an unknown method must fail");

    assert_eq!(err.kind.as_str(), "providerError");
}

#[test]
fn a_second_process_can_be_spawned_independently() {
    // Proves there is no global singleton: two connections coexist, which is
    // what lets the dashboard and the widget poll at different times.
    let Some(first) = server() else {
        eprintln!("skipping: the codex CLI is not installed");
        return;
    };
    let second = aism_lib::testkit::AppServer::spawn("codex").expect("a second server spawns");

    assert!(first
        .request("account/read", Some(serde_json::json!({})))
        .is_ok());
    assert!(second
        .request("account/read", Some(serde_json::json!({})))
        .is_ok());
}

#[test]
fn shutdown_is_clean_and_repeatable() {
    let Some(server) = server() else {
        eprintln!("skipping: the codex CLI is not installed");
        return;
    };

    server.shutdown();
    // Idempotent: a second call, and the drop that follows, must not panic.
    server.shutdown();
}

/// Proves the request timeout path returns rather than hanging.
///
/// A deliberately slow request against a real server would be flaky, so this
/// asserts the shape of the failure with a zero budget instead: with no time
/// left, the call must give up rather than block.
#[test]
fn a_zero_timeout_fails_rather_than_blocking() {
    let Some(server) = server() else {
        eprintln!("skipping: the codex CLI is not installed");
        return;
    };

    let started = std::time::Instant::now();
    let outcome = server.wait_for_turn_completion("never-arrives", Duration::from_millis(1));
    let elapsed = started.elapsed();

    assert!(
        outcome.is_err(),
        "must not wait for a turn that never comes"
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "gave up too slowly: {elapsed:?}"
    );
}
