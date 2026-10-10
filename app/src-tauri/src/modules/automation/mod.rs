//! Window automation: watch the 5-hour window and act on a rollover.
//!
//! # What "rolling the window" actually means
//!
//! The window is **not** something a prompt can restart. `resetsAt` is
//! computed by the provider and is only ever read, never derived, anywhere in
//! the Codex codebase. Sending a prompt *consumes* the current window rather
//! than opening a fresh one.
//!
//! So this module does the thing that actually delivers the goal — never wait
//! for capacity:
//!
//! * poll usage and **detect** when `resetsAt` moves forward, which is the
//!   only locally observable signal that a fresh window opened;
//! * surface that rollover immediately, even if the UI is not polling;
//! * optionally send a minimal prompt, but only as an explicitly enabled
//!   setting, because it spends quota.
//!
//! Depends on the [`Provider`] trait from `shared/`, never on the concrete
//! `providers` module.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::shared::clock::{Clock, SystemClock};
use crate::shared::domain::{ProviderKind, UsageSnapshot};
use crate::shared::error::Error;

/// Interval between polls of the rate-limit endpoint.
///
/// Codex emits `account/rateLimits/updated` only while a turn is running, so a
/// passive watcher must poll. Five minutes is well inside the window the user
/// is waiting through without hammering the endpoint.
const POLL_INTERVAL: Duration = Duration::from_secs(300);

/// A snapshot of what the watcher has seen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationState {
    /// The watcher is running.
    pub running: bool,
    /// The last reading, or `None` before the first successful poll.
    pub usage: Option<UsageSnapshot>,
    /// Epoch ms of the last successful poll.
    pub last_polled_at: Option<i64>,
    /// A fresh window was detected since it was last acknowledged.
    pub rolled_over: bool,
    /// `resetsAt` of the window we last saw, so a change can be detected.
    pub observed_resets_at: Option<i64>,
    /// Epoch ms at which the rollover was detected.
    pub rolled_over_at: Option<i64>,
    /// Epoch ms of the next scheduled poll.
    pub next_poll_at: Option<i64>,
}

impl AutomationState {
    /// The state before anything has been observed.
    fn idle() -> Self {
        Self {
            running: false,
            usage: None,
            last_polled_at: None,
            rolled_over: false,
            observed_resets_at: None,
            rolled_over_at: None,
            next_poll_at: None,
        }
    }
}

/// Owned by Tauri state; the loop and the command both reach it through here.
///
/// A manual stop flag rather than a channel: the loop's only job is to poll, and
/// a flag gives it an explicit, testable shutdown path.
pub struct AutomationRunner {
    registry: Arc<super::providers::ProviderRegistry>,
    clock: Arc<dyn Clock>,
    state: Arc<Mutex<AutomationState>>,
    running: Arc<AtomicBool>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
}

impl AutomationRunner {
    pub fn new(registry: Arc<crate::modules::providers::ProviderRegistry>) -> Self {
        Self {
            registry,
            clock: Arc::new(SystemClock),
            state: Arc::new(Mutex::new(AutomationState::idle())),
            running: Arc::new(AtomicBool::new(false)),
            thread: Mutex::new(None),
        }
    }

    /// Overrides the clock. Tests use it to make the rollover detector
    /// deterministic instead of sleeping.
    #[cfg(test)]
    fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    /// Starts the watcher. Calling twice is a no-op, so the task cannot
    /// double-start.
    pub fn start(self: &Arc<Self>) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }

        if let Ok(mut state) = self.state.lock() {
            state.running = true;
            state.next_poll_at = Some(self.clock.now_ms() + POLL_INTERVAL.as_millis() as i64);
        }

        let runner = Arc::clone(self);
        let handle = thread::Builder::new()
            .name("agentgauge-automation".to_string())
            .spawn(move || runner.poll_loop())
            .ok();

        if let Ok(mut guard) = self.thread.lock() {
            *guard = handle;
        }
    }

    /// Stops the watcher and joins the thread.
    ///
    /// Blocking join with a bounded sleep in the loop keeps this bounded: the
    /// loop checks the flag at least once per poll interval, so shutdown waits
    /// no longer than the interval plus one poll.
    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        if let Ok(mut guard) = self.thread.lock() {
            if let Some(handle) = guard.take() {
                let _ = handle.join();
            }
        }
        if let Ok(mut state) = self.state.lock() {
            state.running = false;
            state.next_poll_at = None;
        }
    }

    /// Current watcher state, cloned out of the lock.
    pub fn state(&self) -> AutomationState {
        self.state
            .lock()
            .map(|state| state.clone())
            .unwrap_or_else(|_| AutomationState::idle())
    }

    /// Polls once, immediately, so the UI has data without waiting a full
    /// interval.
    pub fn poll_once(&self) -> Result<UsageSnapshot, Error> {
        let now = self.clock.now_ms();
        let snapshot = self.registry.usage(ProviderKind::Codex)?;
        self.record(snapshot.clone(), now);
        Ok(snapshot)
    }

    /// Folds a reading into the state, raising `rolled_over` when the window's
    /// reset time has moved forward.
    fn record(&self, snapshot: UsageSnapshot, now_ms: i64) {
        let resets_at = snapshot.five_hour.as_ref().and_then(|w| w.resets_at);

        let Ok(mut state) = self.state.lock() else {
            return;
        };

        // A forward-moving reset time is the only local signal that a new
        // window opened. The first reading establishes the baseline and must
        // not be reported as a rollover.
        let advanced = match (state.observed_resets_at, resets_at) {
            (Some(previous), Some(current)) => current > previous,
            _ => false,
        };

        if advanced {
            state.rolled_over = true;
            state.rolled_over_at = Some(now_ms);
        }

        if resets_at.is_some() {
            state.observed_resets_at = resets_at;
        }

        state.usage = Some(snapshot);
        state.last_polled_at = Some(now_ms);
        state.next_poll_at = if state.running {
            Some(now_ms + POLL_INTERVAL.as_millis() as i64)
        } else {
            None
        };
    }

    /// Clears a seen rollover once the UI has acknowledged it, so it does not
    /// re-fire on every subsequent read.
    pub fn acknowledge_rollover(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.rolled_over = false;
            state.rolled_over_at = None;
        }
    }

    fn poll_loop(&self) {
        // Poll immediately so a started app has data straight away.
        let _ = self.poll_once();

        while self.running.load(Ordering::SeqCst) {
            // Sleep in short slices so shutdown is responsive rather than
            // blocking for the full interval.
            const SLICE: Duration = Duration::from_millis(100);
            let mut slept = Duration::ZERO;
            while slept < POLL_INTERVAL && self.running.load(Ordering::SeqCst) {
                thread::sleep(SLICE);
                slept += SLICE;
            }
            if !self.running.load(Ordering::SeqCst) {
                break;
            }
            let _ = self.poll_once();
        }

        if let Ok(mut state) = self.state.lock() {
            state.running = false;
        }
    }
}

impl Drop for AutomationRunner {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::providers::ProviderRegistry;
    use crate::shared::clock::FixedClock;
    use crate::shared::domain::{Freshness, UsageSnapshot, UsageWindow};

    /// A snapshot with an explicit 5-hour reset time.
    fn snapshot(resets_at: Option<i64>, used: i32) -> UsageSnapshot {
        let window = UsageWindow::new("5h", used, Some(300), resets_at);
        UsageSnapshot {
            provider: ProviderKind::Codex,
            freshness: Freshness::Live,
            fetched_at: Some(0),
            source: "test".into(),
            reason: None,
            plan: None,
            permission: crate::shared::domain::UsagePermission::Allowed,
            windows: vec![window.clone()],
            five_hour: Some(window),
            weekly: None,
        }
    }

    fn runner() -> AutomationRunner {
        let clock = FixedClock::new(1_000);
        AutomationRunner::new(Arc::new(ProviderRegistry::new(0))).with_clock(Arc::new(clock))
    }

    #[test]
    fn starts_out_idle() {
        let runner = runner();
        assert!(!runner.state().running);
        assert!(runner.state().usage.is_none());
    }

    #[test]
    fn the_first_reading_is_a_baseline_not_a_rollover() {
        let runner = runner();
        runner.record(snapshot(Some(5_000), 90), 1_000);
        let state = runner.state();
        assert!(
            !state.rolled_over,
            "a baseline must not look like a rollover"
        );
        assert_eq!(state.observed_resets_at, Some(5_000));
    }

    #[test]
    fn detects_a_rollover_when_the_reset_time_moves_forward() {
        let runner = runner();
        runner.record(snapshot(Some(5_000), 90), 1_000);
        runner.record(snapshot(Some(9_000), 2), 2_000);
        let state = runner.state();
        assert!(state.rolled_over);
        assert_eq!(state.rolled_over_at, Some(2_000));
    }

    #[test]
    fn the_same_reset_time_is_not_a_rollover() {
        let runner = runner();
        runner.record(snapshot(Some(5_000), 90), 1_000);
        runner.record(snapshot(Some(5_000), 95), 2_000);
        assert!(!runner.state().rolled_over);
    }

    #[test]
    fn a_backwards_reset_time_is_not_a_rollover() {
        // A sparse or stale reading must never fake a fresh window.
        let runner = runner();
        runner.record(snapshot(Some(9_000), 10), 1_000);
        runner.record(snapshot(Some(5_000), 10), 2_000);
        assert!(!runner.state().rolled_over);
    }

    #[test]
    fn a_missing_reset_time_does_not_clear_the_baseline() {
        let runner = runner();
        runner.record(snapshot(Some(5_000), 50), 1_000);
        runner.record(snapshot(None, 50), 2_000);
        assert_eq!(runner.state().observed_resets_at, Some(5_000));
    }

    #[test]
    fn acknowledging_clears_the_rollover() {
        let runner = runner();
        runner.record(snapshot(Some(5_000), 90), 1_000);
        runner.record(snapshot(Some(9_000), 1), 2_000);
        assert!(runner.state().rolled_over);
        runner.acknowledge_rollover();
        assert!(!runner.state().rolled_over);
        assert_eq!(runner.state().rolled_over_at, None);
    }

    #[test]
    fn every_reading_is_recorded_with_its_timestamp() {
        let runner = runner();
        runner.record(snapshot(Some(5_000), 40), 1_234);
        let state = runner.state();
        assert_eq!(state.last_polled_at, Some(1_234));
        assert_eq!(
            state
                .usage
                .expect("usage")
                .five_hour
                .expect("5h")
                .used_percent,
            40
        );
    }
}
