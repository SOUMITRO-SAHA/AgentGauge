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

/// Milliseconds in one day.
const DAY_MS: i64 = 86_400_000;

/// The UTC day `now_ms` falls in, as the `YYYY-MM-DD` key the stats store uses.
///
/// UTC, deliberately: it is the boundary providers report on (Z.AI's own
/// timestamps are UTC+8 and Codex's day labels are UTC), so a stored day lines
/// up with its source instead of being reassembled across two vendor days.
///
/// Days-from-civil, inverted. Valid for the whole proleptic Gregorian range, so
/// no lookup table and no date dependency is needed for what is only a key.
pub fn utc_day(now_ms: i64) -> String {
    let days = now_ms.div_euclid(DAY_MS);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// The UTC day `days` before `now_ms`, as a `YYYY-MM-DD` key.
///
/// Subtracts whole days on the day axis rather than subtracting milliseconds
/// from the timestamp, so a boundary never drifts by an hour.
pub fn utc_day_offset(now_ms: i64, days: i64) -> String {
    utc_day(now_ms - days * DAY_MS)
}

/// Whether `value` is a `YYYY-MM-DD` day key this build accepts.
///
/// Shape only. The calendar is not re-derived here: a stored key that parses as
/// a day is already the product of [`utc_day`], and rejecting a real past date
/// would delete history the user earned.
pub fn is_day_key(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
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
