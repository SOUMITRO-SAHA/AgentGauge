//! The file logger.
//!
//! One append-only sink of structured `key=value` lines, modeled on OpenCode's
//! `Logger.toFile` appender: modules emit through the `log` facade macros and
//! this module is the only sink — there is no stderr or stdout logging
//! anywhere in the app. The file rolls over at [`MAX_FILE_BYTES`], and at each
//! startup and UTC day boundary every log file older than [`KEEP_DAYS`] is
//! deleted.
//!
//! Privacy contract: the log must be safe to read whole. The error
//! taxonomy's `Error::message` already promises no secrets and no provider
//! response bodies, and this module enforces that again at write time with a
//! conservative scrubber (email addresses, bearer tokens, credential-shaped
//! runs, the home directory path). Log lines describe outcomes, never
//! payloads.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use log::LevelFilter;

use crate::shared::clock::Clock;
use crate::shared::error::Error;

/// The active file rolls over once it holds this many bytes.
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// Log files older than this many UTC days are deleted.
pub const KEEP_DAYS: i64 = 7;

const LEVEL_ENV: &str = "AGENTGAUGE_LOG_LEVEL";
const FILE_PREFIX: &str = "agentgauge-";
const MS_PER_DAY: i64 = 86_400_000;
const APP_IDENTIFIER: &str = "com.soumitrasaha.agentgauge";

static SINK: OnceLock<Sink> = OnceLock::new();
static MAX_LEVEL_RANK: AtomicU8 = AtomicU8::new(3);

/// Installs the file logger as the process-wide `log` sink.
///
/// Called once per process from the composition root: the app passes
/// `<data dir>/logs`, the headless worker passes
/// [`app_log_dir_from_home`]. Idempotent — the first call wins — and
/// deliberately quiet on failure: a logging outage must never surface as an
/// app error, so an unusable directory simply leaves the app unlogged.
pub fn init(clock: Arc<dyn Clock>, dir: PathBuf) -> Result<(), Error> {
    if SINK.get().is_some() {
        return Ok(());
    }
    let sink = Sink::open_in(clock, dir, MAX_FILE_BYTES, KEEP_DAYS)?;
    let filter = maximum_level();
    MAX_LEVEL_RANK.store(level_rank(filter), Ordering::Relaxed);
    let _ = SINK.set(sink);
    if log::set_boxed_logger(Box::new(FileLogger)).is_ok() {
        log::set_max_level(filter);
        install_panic_hook();
    }
    Ok(())
}

/// The log directory for a process with no Tauri runtime to ask.
///
/// The headless kickoff worker is scheduled only by the macOS LaunchAgent, so
/// this composes the path `app_data_dir` resolves to on macOS —
/// `$HOME/Library/Application Support/<identifier>/logs`. Returns `None` off
/// macOS, where nothing schedules a worker.
pub fn app_log_dir_from_home(home: &std::ffi::OsStr) -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    Some(
        Path::new(home)
            .join("Library/Application Support")
            .join(APP_IDENTIFIER)
            .join("logs"),
    )
}

struct Sink {
    home: Option<String>,
    inner: Mutex<Inner>,
}

struct Inner {
    clock: Arc<dyn Clock>,
    dir: PathBuf,
    max_file_bytes: u64,
    keep_days: i64,
    file: Option<File>,
    day: i64,
    seq: u32,
    written: u64,
}

impl Sink {
    fn open_in(
        clock: Arc<dyn Clock>,
        dir: PathBuf,
        max_file_bytes: u64,
        keep_days: i64,
    ) -> Result<Sink, Error> {
        fs::create_dir_all(&dir).map_err(|error| {
            Error::storage(format!(
                "cannot create the log directory {}: {error}",
                dir.display()
            ))
        })?;
        let today = epoch_days(clock.now_ms());
        purge_dir(&dir, today, keep_days);
        let mut inner = Inner {
            clock,
            dir,
            max_file_bytes,
            keep_days,
            file: None,
            day: today,
            seq: 0,
            written: 0,
        };
        match highest_sequence(&inner.dir, today) {
            Some(seq) if sequence_len(&inner.dir, today, seq) < max_file_bytes => {
                inner.open_file(today, seq)
            }
            Some(seq) => inner.open_file(today, seq + 1),
            None => inner.open_file(today, 0),
        }
        Ok(Sink {
            home: home_from_env().map(|home| home.to_string_lossy().into_owned()),
            inner: Mutex::new(inner),
        })
    }

    fn write(&self, level: log::Level, target: &str, message: &str) {
        let home = self.home.as_deref();
        let target = scrub(target, home);
        let message = scrub(message, home);
        let mut inner = match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let (day, stamp) = timestamp(inner.clock.now_ms());
        if day != inner.day {
            inner.file = None;
            purge_dir(&inner.dir, day, inner.keep_days);
            inner.open_file(day, 0);
        }
        if inner.file.is_none() || inner.written >= inner.max_file_bytes {
            let next = inner.seq + 1;
            inner.open_file(day, next);
        }
        let line = format!(
            "timestamp={stamp} level={level} pid={} target={} message={}\n",
            std::process::id(),
            quote_value(&target),
            quote_value(&message),
        );
        if let Some(file) = inner.file.as_mut() {
            if file
                .write_all(line.as_bytes())
                .and_then(|()| file.flush())
                .is_ok()
            {
                inner.written += line.len() as u64;
            }
        }
    }
}

impl Inner {
    fn open_file(&mut self, day: i64, seq: u32) {
        let path = self.dir.join(file_name(day, seq));
        match OpenOptions::new().create(true).append(true).open(&path) {
            Ok(file) => {
                let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
                self.file = Some(file);
                self.day = day;
                self.seq = seq;
                self.written = len;
            }
            Err(_) => {
                self.file = None;
            }
        }
    }
}

fn purge_dir(dir: &Path, today: i64, keep_days: i64) {
    let oldest = today - (keep_days - 1);
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Some((day, _)) = parse_file_name(&entry.file_name().to_string_lossy()) else {
            continue;
        };
        if day < oldest {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn highest_sequence(dir: &Path, day: i64) -> Option<u32> {
    fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| {
            let (file_day, seq) = parse_file_name(&entry.ok()?.file_name().to_string_lossy())?;
            (file_day == day).then_some(seq)
        })
        .max()
}

fn sequence_len(dir: &Path, day: i64, seq: u32) -> u64 {
    fs::metadata(dir.join(file_name(day, seq)))
        .map(|meta| meta.len())
        .unwrap_or(0)
}

fn file_name(day: i64, seq: u32) -> String {
    let (year, month, date) = civil_from_days(day);
    let base = format!("{FILE_PREFIX}{year:04}{month:02}{date:02}");
    if seq == 0 {
        format!("{base}.log")
    } else {
        format!("{base}.{seq}.log")
    }
}

fn parse_file_name(name: &str) -> Option<(i64, u32)> {
    let rest = name.strip_prefix(FILE_PREFIX)?.strip_suffix(".log")?;
    let (date, seq) = match rest.split_once('.') {
        Some((date, seq)) => (date, seq.parse::<u32>().ok()?),
        None => (rest, 0),
    };
    if date.len() != 8 || !date.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let year: i64 = date[..4].parse().ok()?;
    let month: u32 = date[4..6].parse().ok()?;
    let day: u32 = date[6..8].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some((days_from_civil(year, month, day), seq))
}

fn epoch_days(ms: i64) -> i64 {
    ms.div_euclid(MS_PER_DAY)
}

fn timestamp(ms: i64) -> (i64, String) {
    let days = ms.div_euclid(MS_PER_DAY);
    let rest = ms.rem_euclid(MS_PER_DAY);
    let (year, month, date) = civil_from_days(days);
    let secs = rest / 1000;
    let stamp = format!(
        "{year:04}-{month:02}-{date:02}T{:02}:{:02}:{:02}.{:03}Z",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60,
        rest % 1000,
    );
    (days, stamp)
}

/// Days since 1970-01-01 to a civil date, and back.
///
/// Howard Hinnant's `civil_from_days`/`days_from_civil` algorithms — total,
/// negative-safe arithmetic with no date-library dependency.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let date = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, date)
}

fn days_from_civil(year: i64, month: u32, date: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = (year - era * 400) as u64;
    let mp = if month > 2 { month - 3 } else { month + 9 } as u64;
    let doy = (153 * mp + 2) / 5 + u64::from(date) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe as i64 - 719_468
}

fn home_from_env() -> Option<std::ffi::OsString> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|home| !home.is_empty())
}

fn scrub(text: &str, home: Option<&str>) -> String {
    let mut out = text.to_string();
    if let Some(home) = home {
        if !home.is_empty() {
            out = out.replace(home, "~");
        }
    }
    out = redact_bearer_tokens(&out);
    out = redact_email_addresses(&out);
    redact_credential_runs(&out)
}

const REDACTED: &str = "[redacted]";
const REDACTED_EMAIL: &str = "[redacted-email]";

fn apply_cuts(text: &str, mut cuts: Vec<(usize, usize)>, replacement: &str) -> String {
    if cuts.is_empty() {
        return text.to_string();
    }
    cuts.sort_unstable();
    cuts.dedup();
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    for (start, end) in cuts {
        if start < cursor {
            continue;
        }
        out.push_str(&text[cursor..start]);
        out.push_str(replacement);
        cursor = end;
    }
    out.push_str(&text[cursor..]);
    out
}

fn redact_bearer_tokens(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let bytes = text.as_bytes();
    let mut cuts = Vec::new();
    let mut from = 0;
    while let Some(at) = lower[from..].find("bearer") {
        let mut cursor = from + at + "bearer".len();
        while cursor < bytes.len() && (bytes[cursor] == b':' || bytes[cursor].is_ascii_whitespace())
        {
            cursor += 1;
        }
        let token_start = cursor;
        while cursor < bytes.len() && is_bearer_token_byte(bytes[cursor]) {
            cursor += 1;
        }
        if cursor > token_start {
            cuts.push((token_start, cursor));
            from = cursor;
        } else {
            from = token_start;
        }
    }
    apply_cuts(text, cuts, REDACTED)
}

fn is_bearer_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'~' | b'+' | b'/')
}

fn redact_email_addresses(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut cuts = Vec::new();
    for (at, byte) in bytes.iter().enumerate() {
        if *byte != b'@' {
            continue;
        }
        let mut start = at;
        while start > 0 && is_email_local_byte(bytes[start - 1]) {
            start -= 1;
        }
        let mut end = at + 1;
        while end < bytes.len() && is_email_domain_byte(bytes[end]) {
            end += 1;
        }
        let domain = &text[at + 1..end];
        let tld = domain
            .chars()
            .rev()
            .take_while(|character| character.is_ascii_alphabetic())
            .count();
        if start < at && domain.contains('.') && tld >= 2 {
            cuts.push((start, end));
        }
    }
    apply_cuts(text, cuts, REDACTED_EMAIL)
}

fn is_email_local_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'%' | b'+' | b'-')
}

fn is_email_domain_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-'
}

fn redact_credential_runs(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut cuts = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if !is_credential_byte(bytes[at]) {
            at += 1;
            continue;
        }
        let start = at;
        while at < bytes.len() && is_credential_byte(bytes[at]) {
            at += 1;
        }
        if at - start >= 32 {
            cuts.push((start, at));
        }
    }
    apply_cuts(text, cuts, REDACTED)
}

fn is_credential_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

fn quote_value(value: &str) -> String {
    let plain = !value.is_empty()
        && value.chars().all(|character: char| {
            !matches!(character, ' ' | '=' | '"' | '\\') && !character.is_control()
        });
    if plain {
        value.to_string()
    } else {
        serde_json::to_string(value).unwrap_or_else(|_| "\"[unloggable]\"".to_string())
    }
}

fn level_rank(filter: LevelFilter) -> u8 {
    match filter {
        LevelFilter::Off => 0,
        LevelFilter::Error => 1,
        LevelFilter::Warn => 2,
        LevelFilter::Info => 3,
        LevelFilter::Debug => 4,
        LevelFilter::Trace => 5,
    }
}

fn level_rank_of(level: log::Level) -> u8 {
    match level {
        log::Level::Error => 1,
        log::Level::Warn => 2,
        log::Level::Info => 3,
        log::Level::Debug => 4,
        log::Level::Trace => 5,
    }
}

fn maximum_level() -> LevelFilter {
    match std::env::var(LEVEL_ENV).as_deref() {
        Ok("DEBUG") => LevelFilter::Debug,
        Ok("WARN") => LevelFilter::Warn,
        Ok("ERROR") => LevelFilter::Error,
        _ => LevelFilter::Info,
    }
}

struct FileLogger;

impl log::Log for FileLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        level_rank_of(metadata.level()) <= MAX_LEVEL_RANK.load(Ordering::Relaxed)
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        if let Some(sink) = SINK.get() {
            sink.write(record.level(), record.target(), &record.args().to_string());
        }
    }

    fn flush(&self) {}
}

fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(sink) = SINK.get() {
            let payload = if let Some(text) = info.payload().downcast_ref::<&str>() {
                (*text).to_string()
            } else if let Some(text) = info.payload().downcast_ref::<String>() {
                text.clone()
            } else {
                "panic".to_string()
            };
            let location = info
                .location()
                .map(|location| location.to_string())
                .unwrap_or_default();
            sink.write(
                log::Level::Error,
                "panic",
                &format!("{payload} at {location}"),
            );
        }
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::clock::FixedClock;

    const SEED_MS: i64 = 1_700_000_000_000;
    const DAY_MS: i64 = MS_PER_DAY;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("agentgauge-logging-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn sink_in(dir: &Path) -> Sink {
        Sink::open_in(
            Arc::new(FixedClock::new(SEED_MS)),
            dir.to_path_buf(),
            MAX_FILE_BYTES,
            KEEP_DAYS,
        )
        .expect("sink")
    }

    fn contents(dir: &Path, name: &str) -> String {
        fs::read_to_string(dir.join(name)).expect("log file")
    }

    #[test]
    fn writes_structured_key_value_lines() {
        let dir = scratch("line-shape");
        let sink = sink_in(&dir);
        sink.write(log::Level::Warn, "test", "hello world");
        let line = contents(&dir, &file_name(19_675, 0));
        assert!(
            line.starts_with("timestamp=2023-11-14T22:13:20.000Z level=WARN pid=")
                && line.contains(" target=test message=\"hello world\"\n"),
            "unexpected line: {line:?}"
        );
    }

    #[test]
    fn multiline_messages_stay_on_one_line() {
        let dir = scratch("one-line");
        let sink = sink_in(&dir);
        sink.write(log::Level::Error, "test", "first\nsecond");
        let text = contents(&dir, &file_name(19_675, 0));
        assert_eq!(text.lines().count(), 1);
        assert!(text.contains("first\\nsecond"), "unexpected: {text:?}");
    }

    #[test]
    fn target_with_spaces_is_quoted() {
        let dir = scratch("target-quoted");
        let sink = sink_in(&dir);
        sink.write(log::Level::Warn, "my target", "msg");
        let line = contents(&dir, &file_name(19_675, 0));
        assert!(
            line.contains("target=\"my target\""),
            "target with spaces should be quoted: {line:?}"
        );
        assert_eq!(line.lines().count(), 1);
    }

    #[test]
    fn target_is_scrubbed_for_pii() {
        let dir = scratch("target-scrub");
        let sink = Sink::open_in(
            Arc::new(FixedClock::new(SEED_MS)),
            dir.to_path_buf(),
            MAX_FILE_BYTES,
            KEEP_DAYS,
        )
        .expect("sink");
        sink.write(log::Level::Warn, "dev@example.com", "msg");
        let line = contents(&dir, &file_name(19_675, 0));
        assert!(
            line.contains("[redacted-email]"),
            "email in target should be scrubbed: {line:?}"
        );
        assert!(!line.contains("dev@example.com"));
    }

    #[test]
    fn day_boundary_starts_a_new_file() {
        let dir = scratch("day-roll");
        let sink = sink_in(&dir);
        sink.write(log::Level::Info, "test", "day one");
        sink.inner.lock().expect("inner").clock = Arc::new(FixedClock::new(SEED_MS + DAY_MS));
        sink.write(log::Level::Info, "test", "day two");
        assert!(contents(&dir, &file_name(19_675, 0)).contains("day one"));
        assert!(contents(&dir, &file_name(19_676, 0)).contains("day two"));
    }

    #[test]
    fn oversized_files_roll_to_a_sequence_file() {
        let dir = scratch("size-roll");
        let clock = Arc::new(FixedClock::new(SEED_MS));
        let sink = Sink::open_in(clock, dir.clone(), 240, KEEP_DAYS).expect("sink");
        for turn in 0..6 {
            sink.write(log::Level::Info, "test", &format!("record number {turn}"));
        }
        let first = contents(&dir, &file_name(19_675, 0));
        assert!(first.contains("record number 0"));
        assert!(!first.contains("record number 5"));
        let last = highest_sequence(&dir, 19_675).expect("at least one rolled file");
        assert!(last >= 1, "the cap never triggered a rollover");
        assert!(contents(&dir, &file_name(19_675, last)).contains("record number 5"));
        for seq in 0..=last {
            let len = fs::metadata(dir.join(file_name(19_675, seq)))
                .expect("file exists")
                .len();
            assert!(len < 240 + 160, "file {seq} holds {len} bytes");
        }
    }

    #[test]
    fn startup_purges_files_older_than_seven_days() {
        let dir = scratch("purge");
        let sink = sink_in(&dir);
        sink.write(log::Level::Info, "test", "oldest");
        fs::write(dir.join(file_name(19_676, 0)), "kept boundary\n").expect("seed file");
        fs::write(dir.join(file_name(19_677, 0)), "kept edge\n").expect("seed file");
        sink.inner.lock().expect("inner").clock = Arc::new(FixedClock::new(SEED_MS + 8 * DAY_MS));
        sink.write(log::Level::Info, "test", "fresh");
        assert!(!dir.join(file_name(19_675, 0)).exists());
        assert!(!dir.join(file_name(19_676, 0)).exists());
        assert!(dir.join(file_name(19_677, 0)).exists());
        assert!(contents(&dir, &file_name(19_683, 0)).contains("fresh"));
    }

    #[test]
    fn purge_never_touches_unrecognized_files() {
        let dir = scratch("unknown");
        fs::write(dir.join("notes.txt"), "keep\n").expect("seed");
        fs::write(dir.join("agentgauge-broken.log"), "keep\n").expect("seed");
        fs::write(dir.join(file_name(1_000, 0)), "stale\n").expect("seed");
        purge_dir(&dir, 20_000, KEEP_DAYS);
        assert!(dir.join("notes.txt").exists());
        assert!(dir.join("agentgauge-broken.log").exists());
        assert!(!dir.join(file_name(1_000, 0)).exists());
    }

    #[test]
    fn filenames_round_trip_through_the_parser() {
        for day in [-100_000, -1, 0, 1, 19_675, 999_999] {
            for seq in [0, 1, 12] {
                assert_eq!(
                    parse_file_name(&file_name(day, seq)),
                    Some((day, seq)),
                    "round trip failed for {day}+{seq}"
                );
            }
        }
        assert_eq!(parse_file_name("other.txt"), None);
        assert_eq!(parse_file_name("agentgauge-broken.log"), None);
    }

    #[test]
    fn stamps_are_iso8601_utc() {
        assert_eq!(timestamp(0).1, "1970-01-01T00:00:00.000Z");
        assert_eq!(timestamp(SEED_MS).1, "2023-11-14T22:13:20.000Z");
        assert_eq!(timestamp(-1_500).1, "1969-12-31T23:59:58.500Z");
    }

    #[test]
    fn civil_dates_and_epoch_days_round_trip() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(10_957), (2000, 1, 1));
        assert_eq!(civil_from_days(11_017), (2000, 3, 1));
        assert_eq!(civil_from_days(19_675), (2023, 11, 14));
        for day in [-100_000, -1, 0, 1, 11_017, 19_675, 999_999] {
            let (year, month, date) = civil_from_days(day);
            assert_eq!(days_from_civil(year, month, date), day);
        }
    }

    #[test]
    fn scrub_redacts_email_addresses() {
        assert_eq!(
            scrub("contact dev@example.com today", None),
            "contact [redacted-email] today"
        );
    }

    #[test]
    fn scrub_redacts_bearer_tokens() {
        assert_eq!(
            scrub("Authorization: Bearer abc.def-ghi_123", None),
            "Authorization: Bearer [redacted]"
        );
        assert_eq!(
            scrub("auth bearer:TOKENVALUE-99 ready", None),
            "auth bearer:[redacted] ready"
        );
    }

    #[test]
    fn scrub_redacts_credential_shaped_runs() {
        let key = "a".repeat(40);
        assert_eq!(scrub(&format!("key {key} end"), None), "key [redacted] end");
        assert_eq!(scrub("plain words stay", None), "plain words stay");
    }

    #[test]
    fn scrub_shortens_the_home_directory() {
        assert_eq!(
            scrub("failed on /Users/dev/logs/app.db", Some("/Users/dev")),
            "failed on ~/logs/app.db"
        );
    }

    #[test]
    fn opening_creates_a_missing_directory() {
        let dir = scratch("missing").join("nested/logs");
        Sink::open_in(
            Arc::new(FixedClock::new(SEED_MS)),
            dir.clone(),
            MAX_FILE_BYTES,
            KEEP_DAYS,
        )
        .expect("sink");
        assert!(dir.is_dir());
    }
}
