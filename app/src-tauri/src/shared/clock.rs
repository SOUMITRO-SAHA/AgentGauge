//! An injectable clock.
//!
//! Every module that needs "now" takes a [`Clock`] so tests can drive time
//! deterministically instead of sleeping. Production uses
//! [`SystemClock`]; tests substitute [`FixedClock`].

#[cfg(test)]
use std::sync::atomic::{AtomicI64, Ordering};
#[cfg(test)]
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// Source of the current time, in epoch milliseconds.
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

/// The real clock, backed by the system time.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(delta) => delta.as_millis() as i64,
            // Only reachable if the machine's clock is set before 1970.
            Err(err) => -(err.duration().as_millis() as i64),
        }
    }
}

/// A clock the test advances by hand.
///
/// Test-only: the rollover detector in `automation` is the thing under test and
/// must not depend on wall-clock time, so the seam lives here rather than being
/// duplicated beside it.
#[cfg(test)]
#[derive(Debug, Clone)]
pub struct FixedClock {
    millis: Arc<AtomicI64>,
}

#[cfg(test)]
impl FixedClock {
    pub fn new(now_ms: i64) -> Self {
        Self {
            millis: Arc::new(AtomicI64::new(now_ms)),
        }
    }

    /// Moves the clock forward. Negative deltas are ignored so a test cannot
    /// accidentally produce a non-monotonic sequence.
    pub fn advance(&self, delta_ms: i64) {
        if delta_ms > 0 {
            self.millis.fetch_add(delta_ms, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.millis.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_clock_reads_its_seed() {
        let clock = FixedClock::new(1_700_000_000_000);
        assert_eq!(clock.now_ms(), 1_700_000_000_000);
    }

    #[test]
    fn fixed_clock_advances() {
        let clock = FixedClock::new(0);
        clock.advance(5_000);
        assert_eq!(clock.now_ms(), 5_000);
    }

    #[test]
    fn fixed_clock_ignores_backwards_time() {
        let clock = FixedClock::new(1_000);
        clock.advance(-500);
        assert_eq!(clock.now_ms(), 1_000);
    }

    #[test]
    fn system_clock_is_after_2020() {
        // A cheap guard against a nonsense epoch conversion.
        assert!(SystemClock.now_ms() > 1_577_836_800_000);
    }
}
