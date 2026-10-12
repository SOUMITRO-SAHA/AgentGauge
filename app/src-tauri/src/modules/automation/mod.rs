//! Window automation: one rollover monitor per connected sub.
//!
//! # What "rolling the window" actually means
//!
//! The window is **not** something a prompt can restart. `resetsAt` is
//! computed by the provider and is only ever read, never derived, anywhere in
//! the codebase. Sending a prompt *consumes* the current window rather than
//! opening a fresh one.
//!
//! So each sub's monitor does the thing that actually delivers the goal —
//! never wait for capacity:
//!
//! * poll that sub's usage and **detect** when `resetsAt` moves forward, the
//!   only locally observable signal that a fresh window opened;
//! * surface that rollover immediately, even if the UI is not polling;
//! * never send anything — the scheduled kickoff lives in `modules/kickoff`
//!   behind its own explicit opt-in.
//!
//! Starting a monitor is a **choice**: it is persisted the moment it is made
//! ([`AutomationStore`]) and re-read at every launch, so a sub the user
//! enabled is running again before the first frame renders.
//!
//! Depends on the [`Provider`] trait from `shared/`, never on the concrete
//! `providers` module.

pub(crate) mod store;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::shared::clock::{Clock, SystemClock};
use crate::shared::domain::{ProviderKind, UsageSnapshot};
use crate::shared::error::Error;

pub use store::{AutomationRecord, AutomationStore};

/// Interval between a monitor's polls of its sub's usage endpoint.
///
/// Codex emits `account/rateLimits/updated` only while a turn is running, so a
/// passive watcher must poll. Five minutes is well inside the window the user
/// is waiting through without hammering the endpoint.
const POLL_INTERVAL: Duration = Duration::from_secs(300);

/// Every sub the app knows, in the order the screens render them.
const ALL_KINDS: [ProviderKind; 4] = [
    ProviderKind::Codex,
    ProviderKind::Zai,
    ProviderKind::Minimax,
    ProviderKind::Kimi,
];

/// One sub's monitor state — what the wire carries and what the runner keeps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationState {
    /// Which sub this monitor watches.
    pub kind: ProviderKind,
    /// The monitor is running.
    pub running: bool,
    /// Epoch ms of the last successful poll.
    pub last_polled_at: Option<i64>,
    /// Epoch ms of the next scheduled poll. Never persisted: it is recomputed
    /// the moment the monitor resumes.
    pub next_poll_at: Option<i64>,
    /// `resetsAt` of the window we last saw, so a change can be detected.
    pub observed_resets_at: Option<i64>,
    /// A fresh window was detected since it was last acknowledged.
    pub rolled_over: bool,
    /// Epoch ms at which the rollover was detected.
    pub rolled_over_at: Option<i64>,
}

impl AutomationState {
    /// The state before anything has been observed.
    fn idle(kind: ProviderKind) -> Self {
        Self {
            kind,
            running: false,
            last_polled_at: None,
            next_poll_at: None,
            observed_resets_at: None,
            rolled_over: false,
            rolled_over_at: None,
        }
    }
}

/// Runs a named monitor body and yields its handle, so a stop can join it. A
/// seam so lifecycle tests never spawn real threads against real CLIs.
type Spawner = Arc<
    dyn Fn(&str, Box<dyn FnOnce() + Send + 'static>) -> Option<thread::JoinHandle<()>>
        + Send
        + Sync,
>;

/// Reports one sub's observed reset to the hook the composition root wired.
type OnReading = Arc<dyn Fn(ProviderKind, Option<i64>) + Send + Sync>;

/// The parts of one monitor the polling thread touches, cheap to clone into
/// the thread so the runner's map lock is never held across a poll.
struct Monitor {
    kind: ProviderKind,
    registry: Arc<super::providers::ProviderRegistry>,
    clock: Arc<dyn Clock>,
    state: Arc<Mutex<AutomationState>>,
    running: Arc<AtomicBool>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
    store: Option<Arc<AutomationStore>>,
    on_reading: Option<OnReading>,
}

impl Monitor {
    /// Polls once, immediately, so a started monitor has data straight away.
    fn poll_once(&self) -> Result<UsageSnapshot, Error> {
        let now = self.clock.now_ms();
        let snapshot = self.registry.usage(self.kind)?;
        self.record(snapshot.clone(), now);
        Ok(snapshot)
    }

    /// Folds a reading into the state, raising `rolled_over` when the window's
    /// reset time has moved forward, then persists the fold and reports the
    /// observed reset to the hook the composition root wired (the kickoff
    /// schedule consumes it).
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

        state.last_polled_at = Some(now_ms);
        state.next_poll_at = if state.running {
            Some(now_ms + POLL_INTERVAL.as_millis() as i64)
        } else {
            None
        };
        let enabled = state.running;
        drop(state);

        if let Some(on_reading) = &self.on_reading {
            on_reading(self.kind, resets_at);
        }
        self.persist(enabled);
    }

    /// Persists the choice and the observed state, best-effort: a store that
    /// cannot be written must not break the monitor.
    fn persist(&self, enabled: bool) {
        let Some(store) = &self.store else {
            return;
        };
        let Ok(state) = self.state.lock() else {
            return;
        };
        let _ = store.update(self.kind, |mut record| {
            record.enabled = enabled;
            record.observed_resets_at = state.observed_resets_at;
            record.rolled_over = state.rolled_over;
            record.rolled_over_at = state.rolled_over_at;
            record.last_polled_at = state.last_polled_at;
            record
        });
    }

    fn acknowledge_rollover(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.rolled_over = false;
            state.rolled_over_at = None;
        }
        let enabled = self
            .state
            .lock()
            .map(|state| state.running)
            .unwrap_or(false);
        self.persist(enabled);
    }

    fn poll_loop(self: &Arc<Self>) {
        // Poll immediately so a started monitor has data straight away.
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

/// Owned by Tauri state; the loops and the commands both reach it through
/// here.
pub struct AutomationRunner {
    registry: Arc<super::providers::ProviderRegistry>,
    clock: Arc<dyn Clock>,
    store: Option<Arc<AutomationStore>>,
    on_reading: Option<OnReading>,
    spawner: Spawner,
    monitors: Mutex<HashMap<ProviderKind, Arc<Monitor>>>,
}

impl AutomationRunner {
    pub fn new(registry: Arc<super::providers::ProviderRegistry>) -> Self {
        Self {
            registry,
            clock: Arc::new(SystemClock),
            store: None,
            on_reading: None,
            spawner: Arc::new(|name, body| {
                thread::Builder::new()
                    .name(name.to_string())
                    .spawn(body)
                    .ok()
            }),
            monitors: Mutex::new(HashMap::new()),
        }
    }

    /// Attaches the persisted-choice store. Without it the runner still works
    /// in memory; choices just do not survive a relaunch.
    pub fn with_store(mut self, store: AutomationStore) -> Self {
        self.store = Some(Arc::new(store));
        self
    }

    /// Attaches the reading hook the composition root wires (the kickoff
    /// schedule folds every observed reset in).
    pub fn with_on_reading(mut self, on_reading: OnReading) -> Self {
        self.on_reading = Some(on_reading);
        self
    }

    /// Overrides the clock. Tests use it to make the rollover detector
    /// deterministic instead of sleeping.
    #[cfg(test)]
    fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    /// Replaces the thread spawner. Tests capture instead of spawning, so
    /// lifecycle assertions never touch a real CLI.
    #[cfg(test)]
    fn with_spawner(mut self, spawner: Spawner) -> Self {
        self.spawner = spawner;
        self
    }

    /// Folds a reading into `kind`'s monitor without a thread, so the
    /// rollover detector and the persistence fold are testable.
    #[cfg(test)]
    fn record(&self, kind: ProviderKind, snapshot: UsageSnapshot, now_ms: i64) {
        self.monitor(kind).record(snapshot, now_ms);
    }

    /// Starts one sub's monitor. Calling twice for the same sub is a no-op,
    /// so a monitor cannot double-start.
    pub fn start(&self, kind: ProviderKind) {
        let monitor = self.monitor(kind);
        if monitor.running.swap(true, Ordering::SeqCst) {
            return;
        }

        if let Ok(mut state) = monitor.state.lock() {
            state.running = true;
            state.next_poll_at = Some(monitor.clock.now_ms() + POLL_INTERVAL.as_millis() as i64);
        }
        monitor.persist(true);

        let for_thread = Arc::clone(&monitor);
        let handle = (self.spawner)(
            &format!("agentgauge-automation-{}", kind.as_str()),
            Box::new(move || for_thread.poll_loop()),
        );
        // The trailing semicolon matters: the lock's temporary must drop
        // before `monitor` under this edition's if-let drop rules.
        if let Ok(mut guard) = monitor.thread.lock() {
            *guard = handle;
        };
    }

    /// Stops one sub's monitor and joins its thread.
    ///
    /// Blocking join with a bounded sleep in the loop keeps this bounded: the
    /// loop checks the flag at least once per poll interval, so shutdown waits
    /// no longer than the interval plus one poll.
    pub fn stop(&self, kind: ProviderKind) {
        let monitor = {
            let mut monitors = self.monitors.lock().unwrap_or_else(PoisonError::into_inner);
            monitors.remove(&kind)
        };
        let Some(monitor) = monitor else {
            return;
        };
        monitor.running.store(false, Ordering::SeqCst);
        if let Ok(mut guard) = monitor.thread.lock() {
            if let Some(handle) = guard.take() {
                let _ = handle.join();
            }
        }
        if let Ok(mut state) = monitor.state.lock() {
            state.running = false;
            state.next_poll_at = None;
        }
        monitor.persist(false);
    }

    /// Every sub's monitor state, in the canonical screen order. A sub that
    /// has never been touched renders its persisted record, or idle.
    pub fn overview(&self) -> Vec<AutomationState> {
        ALL_KINDS
            .into_iter()
            .map(|kind| self.state_for(kind))
            .collect()
    }

    /// One sub's monitor state, cloned out of the lock.
    pub fn state_for(&self, kind: ProviderKind) -> AutomationState {
        self.monitor(kind)
            .state
            .lock()
            .map(|state| state.clone())
            .unwrap_or_else(|_| AutomationState::idle(kind))
    }

    /// Clears a seen rollover once the UI has acknowledged it, so it does not
    /// re-fire on every subsequent read.
    pub fn acknowledge_rollover(&self, kind: ProviderKind) {
        self.monitor(kind).acknowledge_rollover();
    }

    /// Restarts every sub the user left enabled, restoring the observed
    /// rollover state first. Called once from the composition root at
    /// startup, before the renderer asks anything: the choice is already
    /// running, and the screen shows continuity instead of blanks.
    pub fn resume_persisted(&self) {
        let Some(store) = &self.store else {
            return;
        };
        for record in store.load().records.into_iter().filter(|r| r.enabled) {
            self.start(record.kind);
        }
    }

    /// The monitor for `kind`, created on first touch and seeded from the
    /// persisted record so an untouched relaunch still shows the last
    /// observed state.
    fn monitor(&self, kind: ProviderKind) -> Arc<Monitor> {
        let mut monitors = self.monitors.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(monitor) = monitors.get(&kind) {
            return Arc::clone(monitor);
        }

        let record = self
            .store
            .as_ref()
            .map(|store| store.record(kind))
            .unwrap_or_else(|| AutomationRecord::new(kind));

        let state = AutomationState {
            kind,
            running: false,
            last_polled_at: record.last_polled_at,
            next_poll_at: None,
            observed_resets_at: record.observed_resets_at,
            rolled_over: record.rolled_over,
            rolled_over_at: record.rolled_over_at,
        };

        let monitor = Arc::new(Monitor {
            kind,
            registry: Arc::clone(&self.registry),
            clock: Arc::clone(&self.clock),
            state: Arc::new(Mutex::new(state)),
            running: Arc::new(AtomicBool::new(false)),
            thread: Mutex::new(None),
            store: self.store.clone(),
            on_reading: self.on_reading.clone(),
        });
        monitors.insert(kind, Arc::clone(&monitor));
        monitor
    }
}

impl Drop for AutomationRunner {
    fn drop(&mut self) {
        for monitor in self
            .monitors
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
        {
            monitor.running.store(false, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::providers::ProviderRegistry;
    use crate::shared::clock::FixedClock;
    use crate::shared::domain::{Freshness, UsagePermission, UsageWindow};

    /// A snapshot with an explicit 5-hour reset time.
    fn snapshot(provider: ProviderKind, resets_at: Option<i64>, used: i32) -> UsageSnapshot {
        let window = UsageWindow::new("5h", used, Some(300), resets_at);
        UsageSnapshot {
            provider,
            freshness: Freshness::Live,
            fetched_at: Some(0),
            source: "test".into(),
            reason: None,
            plan: None,
            permission: UsagePermission::Allowed,
            windows: vec![window.clone()],
            five_hour: Some(window),
            weekly: None,
        }
    }

    /// A runner whose "threads" are captured, never run: lifecycle assertions
    /// stay pure and no test ever touches a real CLI.
    fn runner(store: Option<AutomationStore>) -> AutomationRunner {
        let built = AutomationRunner::new(Arc::new(ProviderRegistry::new()))
            .with_clock(Arc::new(FixedClock::new(1_000)))
            .with_spawner(Arc::new(|_name, _body| None));
        match store {
            Some(store) => built.with_store(store),
            None => built,
        }
    }

    fn capturing_spawner() -> Arc<Mutex<Vec<String>>> {
        Arc::new(Mutex::new(Vec::new()))
    }

    /// A store over a throwaway database.
    fn temp_store(name: &str) -> AutomationStore {
        let dir = std::env::temp_dir().join(format!("agentgauge-automation-runner-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("creates dir");
        let db = crate::shared::database::Database::open(&dir.join("agentgauge.db"))
            .expect("opens a temp database");
        AutomationStore::new(Arc::new(db))
    }

    #[test]
    fn starts_out_idle_for_every_kind() {
        let runner = runner(None);
        for state in runner.overview() {
            assert!(!state.running);
            assert_eq!(state.last_polled_at, None);
        }
        assert_eq!(runner.overview().len(), 4, "one monitor row per known sub");
    }

    #[test]
    fn monitors_are_isolated_per_kind() {
        let runner = runner(None);
        runner.record(
            ProviderKind::Codex,
            snapshot(ProviderKind::Codex, Some(5_000), 90),
            1_000,
        );
        runner.record(
            ProviderKind::Codex,
            snapshot(ProviderKind::Codex, Some(9_000), 2),
            2_000,
        );
        runner.record(
            ProviderKind::Zai,
            snapshot(ProviderKind::Zai, Some(5_000), 50),
            3_000,
        );

        assert!(runner.state_for(ProviderKind::Codex).rolled_over);
        assert!(
            !runner.state_for(ProviderKind::Zai).rolled_over,
            "codex's rollover must not leak into zai"
        );
        assert_eq!(
            runner.state_for(ProviderKind::Zai).last_polled_at,
            Some(3_000)
        );
    }

    #[test]
    fn rollover_detection_rules_hold_per_kind() {
        // Baseline is not a rollover; the same reset is not a rollover; a
        // backwards reset is not a rollover; a missing reset keeps the
        // baseline.
        let runner = runner(None);
        let codex = ProviderKind::Codex;
        runner.record(codex, snapshot(codex, Some(5_000), 90), 1_000);
        assert!(!runner.state_for(codex).rolled_over);
        runner.record(codex, snapshot(codex, Some(5_000), 95), 2_000);
        assert!(!runner.state_for(codex).rolled_over);
        runner.record(codex, snapshot(codex, Some(9_000), 10), 3_000);
        assert!(runner.state_for(codex).rolled_over);
        runner.acknowledge_rollover(codex);
        assert!(!runner.state_for(codex).rolled_over);
        runner.record(codex, snapshot(codex, Some(4_000), 10), 4_000);
        assert!(
            !runner.state_for(codex).rolled_over,
            "backwards is not fresh"
        );
        runner.record(codex, snapshot(codex, None, 10), 5_000);
        assert_eq!(runner.state_for(codex).observed_resets_at, Some(4_000));
    }

    #[test]
    fn starting_marks_only_that_kind_running_and_persists_the_choice() {
        let store = temp_store("start");
        let runner = runner(Some(store));
        runner.start(ProviderKind::Codex);

        assert!(runner.state_for(ProviderKind::Codex).running);
        assert!(!runner.state_for(ProviderKind::Zai).running);
        assert_eq!(
            runner.state_for(ProviderKind::Codex).next_poll_at,
            Some(1_000 + POLL_INTERVAL.as_millis() as i64)
        );
        let record = runner
            .store
            .as_ref()
            .expect("store")
            .record(ProviderKind::Codex);
        assert!(record.enabled, "starting is a choice: it must persist");
    }

    #[test]
    fn stopping_persists_the_choice_and_clears_the_schedule() {
        let store = temp_store("stop");
        let runner = runner(Some(store));
        runner.start(ProviderKind::Kimi);
        runner.stop(ProviderKind::Kimi);

        let state = runner.state_for(ProviderKind::Kimi);
        assert!(!state.running);
        assert_eq!(state.next_poll_at, None);
        assert!(
            !runner
                .store
                .as_ref()
                .expect("store")
                .record(ProviderKind::Kimi)
                .enabled
        );
    }

    #[test]
    fn resume_persisted_starts_exactly_the_enabled_subs_and_restores_state() {
        let store = temp_store("resume");
        store
            .update(ProviderKind::Zai, |mut record| {
                record.enabled = true;
                record.observed_resets_at = Some(7_000);
                record.last_polled_at = Some(500);
                record
            })
            .expect("seeds");
        let spawner = capturing_spawner();
        let names = Arc::clone(&spawner);
        let runner = AutomationRunner::new(Arc::new(ProviderRegistry::new()))
            .with_clock(Arc::new(FixedClock::new(1_000)))
            .with_store(store)
            .with_spawner(Arc::new(move |name, _body| {
                names.lock().expect("names").push(name.to_string());
                None
            }));

        runner.resume_persisted();

        let zai = runner.state_for(ProviderKind::Zai);
        assert!(zai.running, "the persisted choice must auto-resume");
        assert_eq!(zai.observed_resets_at, Some(7_000), "continuity restored");
        assert_eq!(zai.last_polled_at, Some(500));
        assert!(!runner.state_for(ProviderKind::Codex).running);
        let names = spawner.lock().expect("names");
        assert_eq!(
            names.as_slice(),
            ["agentgauge-automation-zai".to_string()],
            "exactly the enabled subs spawn"
        );
    }

    #[test]
    fn a_reading_is_persisted_with_its_observed_state() {
        let store = temp_store("observe");
        let runner = runner(Some(store));

        runner.record(
            ProviderKind::Codex,
            snapshot(ProviderKind::Codex, Some(5_000), 40),
            1_234,
        );

        let record = runner
            .store
            .as_ref()
            .expect("store")
            .record(ProviderKind::Codex);
        assert_eq!(record.observed_resets_at, Some(5_000));
        assert_eq!(record.last_polled_at, Some(1_234));
        assert!(!record.enabled, "a reading alone does not enable a sub");
    }

    #[test]
    fn the_reading_hook_sees_every_observed_reset() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let capture = Arc::clone(&seen);
        let runner = AutomationRunner::new(Arc::new(ProviderRegistry::new()))
            .with_clock(Arc::new(FixedClock::new(1_000)))
            .with_spawner(Arc::new(|_name, _body| None))
            .with_on_reading(Arc::new(move |kind, resets_at| {
                capture.lock().expect("seen").push((kind, resets_at));
            }));

        runner.record(
            ProviderKind::Codex,
            snapshot(ProviderKind::Codex, Some(5_000), 40),
            1_000,
        );
        runner.record(
            ProviderKind::Codex,
            snapshot(ProviderKind::Codex, None, 40),
            2_000,
        );

        assert_eq!(
            seen.lock().expect("seen").as_slice(),
            [
                (ProviderKind::Codex, Some(5_000)),
                (ProviderKind::Codex, None),
            ]
        );
    }

    #[test]
    fn stopping_a_never_started_kind_is_a_no_op() {
        let runner = runner(None);
        runner.stop(ProviderKind::Kimi);
        assert!(!runner.state_for(ProviderKind::Kimi).running);
    }
}
