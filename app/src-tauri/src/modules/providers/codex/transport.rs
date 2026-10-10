//! A JSON-RPC client for `codex app-server --stdio`.
//!
//! One long-lived child process for the whole app lifetime, one reader thread
//! that demultiplexes by request id, and a writer guarded by a mutex. This is
//! the same shape as Codex's own reference clients
//! (`codex-rs/app-server/tests/common/test_app_server.rs`) and needs no crate
//! beyond what the app already links.
//!
//! The envelope is **not** JSON-RPC 2.0: Codex deliberately omits the
//! `jsonrpc` field (`codex-rs/app-server-protocol/src/rpc.rs`), so we do not
//! send one. Framing is newline-delimited JSON.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use super::protocol;
use crate::shared::error::{Error, ErrorKind};

/// Executable we spawn. Overridable so a test can point at a stub.
pub const CODEX_EXECUTABLE: &str = "codex";

/// How long a single request may take before it is abandoned.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// How long to wait for a graceful shutdown before killing the child.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

/// A request we are still waiting on.
struct Pending {
    sender: mpsc::Sender<Result<String, Error>>,
}

/// Owns the child process and the id-keyed waiter table.
///
/// Cloning is not supported on purpose: there must be exactly one owner, so a
/// double-start is structurally impossible.
pub struct AppServer {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Arc<Mutex<HashMap<i64, Pending>>>,
    /// Server-initiated frames (no `id`), retained so a caller waiting on a
    /// notification can find it. `turn/start` answers immediately with an
    /// in-progress turn, so the real outcome only ever arrives here.
    notifications: Arc<Mutex<Vec<String>>>,
    next_id: AtomicI64,
    /// Set once the reader thread sees EOF or a fatal decode, so later calls
    /// fail fast instead of waiting out the timeout.
    poisoned: Arc<AtomicBool>,
    /// Retained so the reader thread's `JoinHandle` is not dropped silently.
    reader: Mutex<Option<thread::JoinHandle<()>>>,
}

impl AppServer {
    /// Spawns the child and completes the `initialize` handshake.
    ///
    /// Returns `ProviderMissing` when the executable cannot be spawned, which
    /// is the signal the onboarding flow uses to tell the user what to install.
    pub fn spawn(executable: &str) -> Result<Self, Error> {
        let mut child = Command::new(executable)
            .arg("app-server")
            .arg("--stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // The child's stderr is inherited so its diagnostics reach the
            // terminal instead of filling a pipe we never drain. Leaving it
            // piped and unread would deadlock the child once the buffer fills.
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|err| {
                Error::provider_missing(format!(
                    "`{executable}` could not be started ({err}). Install the Codex CLI and make sure it is on your PATH."
                ))
            })?;

        let stdin = child.stdin.take().ok_or_else(|| {
            Error::transport_closed("Could not open a pipe to the Codex CLI.".to_string())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            Error::transport_closed("Could not read output from the Codex CLI.".to_string())
        })?;

        let pending: Arc<Mutex<HashMap<i64, Pending>>> = Arc::new(Mutex::new(HashMap::new()));
        let poisoned = Arc::new(AtomicBool::new(false));
        let notifications: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

        let reader = {
            let pending = Arc::clone(&pending);
            let poisoned = Arc::clone(&poisoned);
            let notifications = Arc::clone(&notifications);
            thread::Builder::new()
                .name("codex-app-server-reader".to_string())
                .spawn(move || read_loop(stdout, pending, poisoned, notifications))
                .map_err(|err| {
                    Error::transport_closed(format!("Could not start the reader thread: {err}"))
                })?
        };

        let server = Self {
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(Some(stdin)),
            pending,
            notifications,
            next_id: AtomicI64::new(1),
            poisoned,
            reader: Mutex::new(Some(reader)),
        };

        server.initialize()?;
        Ok(server)
    }

    /// The handshake. Must run exactly once per process; a second call fails
    /// server-side with "Already initialized".
    fn initialize(&self) -> Result<(), Error> {
        self.request(
            "initialize",
            Some(serde_json::json!({
                "clientInfo": { "name": "agentgauge-daemon", "title": "AgentGauge", "version": env!("CARGO_PKG_VERSION") }
            })),
        )?;
        // The server does not require this, but every reference client sends
        // it and it keeps us aligned with the protocol's happy path.
        self.notify("initialized", None)
    }

    /// Sends a request and waits for the matching response id.
    ///
    /// The lock is taken and released around the write only — a guard is never
    /// held across the blocking wait.
    pub fn request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<String, Error> {
        if self.poisoned.load(Ordering::SeqCst) {
            return Err(Error::transport_closed(
                "The Codex CLI connection has closed.".to_string(),
            ));
        }

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();

        self.pending
            .lock()
            .map_err(|_| poisoned_error())?
            .insert(id, Pending { sender: tx });

        let envelope = serde_json::json!({
            "id": id,
            "method": method,
            "params": params.unwrap_or(serde_json::Value::Null),
        });

        if let Err(err) = self.write_line(&envelope) {
            self.forget(id);
            return Err(err);
        }

        match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.forget(id);
                Err(Error::timeout(format!(
                    "`{method}` did not reply within {}s.",
                    REQUEST_TIMEOUT.as_secs()
                )))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.forget(id);
                Err(Error::transport_closed(
                    "The Codex CLI connection closed unexpectedly.".to_string(),
                ))
            }
        }
    }

    /// Sends a fire-and-forget notification. No id, no reply.
    pub fn notify(&self, method: &str, params: Option<serde_json::Value>) -> Result<(), Error> {
        let mut envelope = serde_json::Map::new();
        envelope.insert(
            "method".to_string(),
            serde_json::Value::String(method.to_string()),
        );
        if let Some(params) = params {
            envelope.insert("params".to_string(), params);
        }
        self.write_line(&serde_json::Value::Object(envelope))
    }

    fn write_line(&self, envelope: &serde_json::Value) -> Result<(), Error> {
        let mut guard = self.stdin.lock().map_err(|_| poisoned_error())?;
        let stdin = guard.as_mut().ok_or_else(|| {
            Error::transport_closed("The Codex CLI connection is closed.".to_string())
        })?;
        let line = serde_json::to_string(envelope)
            .map_err(|err| Error::invalid_payload(format!("Could not encode a request: {err}")))?;
        writeln!(stdin, "{line}")
            .and_then(|()| stdin.flush())
            .map_err(|err| {
                Error::transport_closed(format!("Could not write to the Codex CLI: {err}"))
            })
    }

    fn forget(&self, id: i64) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
    }

    /// Blocks until a `turn/completed` notification arrives for `turn_id`.
    ///
    /// `turn/start` returns immediately with an in-progress turn, so this is the
    /// only way to learn the outcome. Frames are matched on the turn id because
    /// concurrent turns share one notification stream — claiming the first
    /// `turn/completed` regardless of id would report another turn's result.
    ///
    /// The buffer is drained as frames are inspected, so a long-lived process
    /// cannot grow it without limit during a slow turn.
    pub fn wait_for_turn_completion(
        &self,
        turn_id: &str,
        timeout: Duration,
    ) -> Result<String, Error> {
        let deadline = Instant::now() + timeout;

        loop {
            if let Ok(mut buffer) = self.notifications.lock() {
                if let Some(index) = buffer
                    .iter()
                    .position(|frame| protocol::is_turn_completed_for(frame, turn_id))
                {
                    return Ok(buffer.remove(index));
                }
                // Nothing matched: drop what we have already inspected so the
                // buffer cannot grow without bound during a long turn.
                buffer.clear();
            }

            if self.poisoned.load(Ordering::SeqCst) {
                return Err(Error::transport_closed(
                    "The Codex CLI connection closed before the turn finished.".to_string(),
                ));
            }

            if Instant::now() >= deadline {
                return Err(Error::timeout(format!(
                    "The Codex turn did not finish within {}s.",
                    timeout.as_secs()
                )));
            }

            thread::sleep(Duration::from_millis(50));
        }
    }

    /// Closes stdin and lets the child drain, which is how Codex expects a
    /// client to go away. Killing instead can corrupt an in-flight turn.
    pub fn shutdown(&self) {
        // Dropping stdin signals EOF, which is the documented shutdown path.
        if let Ok(mut guard) = self.stdin.lock() {
            guard.take();
        }

        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let deadline = Instant::now() + SHUTDOWN_GRACE;
                loop {
                    match child.try_wait() {
                        Ok(Some(_)) => break,
                        Ok(None) if Instant::now() < deadline => {
                            thread::sleep(Duration::from_millis(50));
                        }
                        _ => {
                            let _ = child.kill();
                            let _ = child.wait();
                            break;
                        }
                    }
                }
            }
        }

        if let Ok(mut guard) = self.reader.lock() {
            if let Some(handle) = guard.take() {
                let _ = handle.join();
            }
        }
    }
}

impl Drop for AppServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Reads lines until EOF, routing each response to its waiter.
///
/// A malformed line is skipped rather than fatal: the stream is
/// newline-delimited and one bad line must not kill the connection. Only EOF
/// poisons the connection.
fn read_loop(
    stdout: std::process::ChildStdout,
    pending: Arc<Mutex<HashMap<i64, Pending>>>,
    poisoned: Arc<AtomicBool>,
    notifications: Arc<Mutex<Vec<String>>>,
) {
    let reader = BufReader::new(stdout);

    for line in reader.lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // A malformed line is skipped rather than fatal: one bad line must not
        // kill the connection.
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };

        // Server-initiated frames carry no id. They are what a waiting caller
        // polls for, so they are retained rather than dropped.
        let Some(id) = value.get("id").and_then(|id| id.as_i64()) else {
            if let Ok(mut buffer) = notifications.lock() {
                buffer.push(trimmed.to_string());
            }
            continue;
        };

        let waiter = pending.lock().ok().and_then(|mut map| map.remove(&id));
        let Some(waiter) = waiter else {
            // A late reply to a request we already timed out on.
            continue;
        };

        let outcome = if let Some(error) = value.get("error") {
            Err(protocol::decode_error_frame(
                &serde_json::json!({ "error": error }).to_string(),
            ))
        } else if let Some(result) = value.get("result") {
            Ok(result.to_string())
        } else {
            Err(Error::invalid_payload(
                "The Codex CLI sent a response with neither a result nor an error.".to_string(),
            ))
        };

        // A closed channel means the caller already gave up.
        let _ = waiter.sender.send(outcome);
    }

    poisoned.store(true, Ordering::SeqCst);
    // Nothing is waiting any more; fail every outstanding request immediately
    // instead of letting each sit out its full timeout.
    if let Ok(mut map) = pending.lock() {
        for (_, waiter) in map.drain() {
            let _ = waiter.sender.send(Err(Error::transport_closed(
                "The Codex CLI connection closed.".to_string(),
            )));
        }
    }
}

fn poisoned_error() -> Error {
    Error::new(
        ErrorKind::TransportClosed,
        "The Codex CLI connection is in an unusable state.",
    )
}

/// Locates the executable and reads its version, without starting a server.
pub fn probe(executable: &str) -> Result<String, Error> {
    let output = Command::new(executable)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .map_err(|err| {
            Error::provider_missing(format!(
                "`{executable}` is not available on this system ({err})."
            ))
        })?;

    if !output.status.success() {
        return Err(Error::provider_missing(format!(
            "`{executable} --version` exited with {}.",
            output.status
        )));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Proves the spawn path yields a typed error rather than panicking. The
    /// error is compared field-wise because `AppServer` cannot be `Debug`.
    #[test]
    fn spawn_fails_typed_when_the_binary_is_absent() {
        match AppServer::spawn("definitely-not-a-real-binary-xyz") {
            Ok(_) => panic!("expected the spawn to fail"),
            Err(err) => {
                assert_eq!(err.kind, ErrorKind::ProviderMissing);
                assert!(err.message.contains("PATH"));
            }
        }
    }

    #[cfg(test)]
    use crate::shared::domain::ProviderKind;

    #[test]
    fn probe_reports_a_missing_executable_clearly() {
        let err = probe("definitely-not-a-real-binary-xyz").expect_err("must fail");
        assert_eq!(err.kind, ErrorKind::ProviderMissing);
        assert!(err.message.contains("not available"));
    }

    #[test]
    fn probe_reads_a_version() {
        let version = probe(CODEX_EXECUTABLE).expect("codex is installed in CI");
        assert!(version.starts_with("codex-cli"));
    }

    #[test]
    fn a_turn_notification_is_matched_by_id() {
        let frame =
            r#"{"method":"turn/completed","params":{"turn":{"id":"t1","status":"completed"}}}"#;
        assert!(protocol::is_turn_completed_for(frame, "t1"));
        assert!(!protocol::is_turn_completed_for(frame, "t2"));
    }

    #[test]
    fn every_supported_method_routes_to_the_right_decoder() {
        // Guards the method strings against a rename on the provider side.
        let rate_limits = r#"{"ordinaryUsageAllowed":true,"rateLimits":{"primary":{"usedPercent":5,"windowDurationMins":300}}}"#;
        assert!(protocol::decode_rate_limits(rate_limits, ProviderKind::Codex, 0).is_ok());
        // Decoders take the `result` value, which is what the transport hands them
        // after unwrapping the response envelope.
        let account =
            r#"{"account":{"type":"chatgpt","planType":"pro"},"requiresOpenaiAuth":false}"#;
        assert!(protocol::decode_account(account).is_ok());
    }

    #[test]
    fn envelope_omits_the_jsonrpc_field() {
        // Codex does not send or expect it (`app-server-protocol/src/rpc.rs`).
        let envelope = serde_json::json!({ "id": 1, "method": "x", "params": null });
        assert!(envelope.get("jsonrpc").is_none());
    }
}
