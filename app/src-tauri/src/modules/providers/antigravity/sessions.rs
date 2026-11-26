//! Antigravity's own local session record, read from the files its CLI and
//! IDE surfaces maintain under `~/.gemini/`.
//!
//! Antigravity records sessions — not tokens. Its conversation databases
//! store protobuf blobs with no plain-text token counts, its summaries
//! database carries per-conversation timestamps and step counts, and quota
//! lives behind an internal Google API whose credentials never leave the OS
//! keyring. The honest local reading is therefore session activity: how many
//! sessions this machine recorded, on which days, across which surfaces.
//! Everything this module cannot honestly report — tokens, models, cost,
//! quota windows — stays absent rather than zero.
//!
//! Three constraints follow from reading another application's storage, the
//! same ones `modules::opencode::db` documents:
//!
//! * **Never write.** Every connection is read-only; a running Antigravity
//!   process may hold the database at any moment.
//! * **Never depend on the schema.** The summaries table is checked by shape
//!   and a surface that no longer matches degrades to per-file session
//!   counting rather than to an error or a wrong number.
//! * **Count what could not be read.** A summaries database that cannot be
//!   opened — or whose shape has moved — lands in `files_unreadable`, so the
//!   reading says what is missing instead of implying a complete picture.
//!   Conversation files are counted by existence, so their sessions are not
//!   lost to a format this module does not parse.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::{Connection, OpenFlags};

use crate::shared::domain::{LocalSessionDayUsage, LocalUsage};

/// The data surfaces Antigravity maintains under `~/.gemini/`, in the order
/// they are reported. `antigravity` is the IDE 2.0 directory third-party
/// tooling documents; it is absent on some installs and simply contributes
/// nothing then.
const SURFACES: [&str; 4] = [
    "antigravity-cli",
    "antigravity-ide",
    "antigravity-acp",
    "antigravity",
];

/// The summaries database name, present on surfaces that maintain one.
const SUMMARIES_DB: &str = "conversation_summaries.db";

/// Columns the summaries read needs. A table missing any of them is not a
/// summaries table this module can read, whatever it is called.
const REQUIRED_SUMMARY_COLUMNS: [&str; 3] = [
    "conversation_id",
    "last_modified_time",
    "last_user_input_time",
];

/// Times before this year are sentinels (`0001-01-01` marks "never"), not
/// dates a session was recorded on.
const PLAUSIBLE_YEAR: u32 = 2000;

/// The `~/.gemini` data root, or `None` when the home directory cannot be
/// resolved.
pub fn gemini_home() -> Option<PathBuf> {
    crate::shared::executable::home_directory().map(|home| home.join(".gemini"))
}

/// Reads every Antigravity surface under the data root into the domain's
/// local-usage shape.
///
/// A conversation is counted once across all surfaces. The summaries database
/// dates a session from its timestamps; when those are sentinels, the
/// conversation file's own mtime dates it instead, so a session lands on a
/// day whenever any record on disk can establish one.
///
/// Returns `None` — not an empty reading — when no surface holds any session
/// record at all, so the UI can say the local record is absent rather than
/// showing a confident zero.
pub fn read_sessions(home: &Path) -> Option<LocalUsage> {
    let mut sessions: Vec<SessionRecord> = Vec::new();
    let mut positions: HashMap<String, usize> = HashMap::new();
    let mut files_scanned = 0u64;
    let mut files_unreadable = 0u64;

    for surface in SURFACES {
        let surface_dir = home.join(surface);
        if !surface_dir.is_dir() {
            continue;
        }

        let summaries = surface_dir.join(SUMMARIES_DB);
        if summaries.is_file() {
            files_scanned += 1;
            match read_summary_rows(&summaries) {
                Some(rows) => {
                    for row in rows {
                        if let Some(position) = positions.get(&row.id) {
                            // The file counts the same conversation once, but
                            // its own mtime can date a summary row whose
                            // timestamps are sentinels.
                            let session = &mut sessions[*position];
                            if session.day.is_none() {
                                session.day = row.day;
                            }
                        } else {
                            positions.insert(row.id.clone(), sessions.len());
                            sessions.push(row);
                        }
                    }
                }
                None => files_unreadable += 1,
            }
        }

        let conversations = surface_dir.join("conversations");
        let Ok(entries) = fs::read_dir(&conversations) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(kind) = record_kind(&path) else {
                continue;
            };
            match kind {
                RecordKind::SessionDatabase | RecordKind::LegacyBlob => {
                    files_scanned += 1;
                    let id = stem(&path);
                    let day = entry
                        .metadata()
                        .ok()
                        .and_then(|metadata| modified_day(&metadata));
                    if let Some(position) = positions.get(&id) {
                        let session = &mut sessions[*position];
                        if session.day.is_none() {
                            session.day = day;
                        }
                        continue;
                    }
                    positions.insert(id.clone(), sessions.len());
                    sessions.push(SessionRecord { id, day });
                }
            }
        }
    }

    if sessions.is_empty() && files_unreadable == 0 {
        return None;
    }

    let mut day_counts: BTreeMap<String, u64> = BTreeMap::new();
    for session in &sessions {
        if let Some(day) = &session.day {
            *day_counts.entry(day.clone()).or_default() += 1;
        }
    }
    let session_days = day_counts
        .iter()
        .map(|(day, sessions)| LocalSessionDayUsage {
            day: day.clone(),
            sessions: *sessions,
        })
        .collect::<Vec<_>>();
    let first_day = session_days.first().map(|day| day.day.clone());
    let last_day = session_days.last().map(|day| day.day.clone());

    Some(LocalUsage {
        models: Vec::new(),
        model_days: Vec::new(),
        projects: Vec::new(),
        days: Vec::new(),
        session_days,
        median_tokens_per_session: None,
        compactions: None,
        cost_usd: 0.0,
        unpriced_tokens: 0,
        sessions: sessions.len() as u64,
        files_scanned,
        files_unreadable,
        files_compressed: 0,
        first_day,
        last_day,
    })
}

/// One counted session: its conversation id and the day it was last worked
/// on, when any record could establish that.
struct SessionRecord {
    id: String,
    day: Option<String>,
}

enum RecordKind {
    SessionDatabase,
    LegacyBlob,
}

/// Classifies a conversations-directory entry. Sidecars (`-wal`, `-shm`,
/// `.meta`, journals) are not session records. Both current SQLite databases
/// and legacy encrypted `.pb` sessions count by existence — this module never
/// opens them, so their day comes from the file, not their contents.
fn record_kind(path: &Path) -> Option<RecordKind> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    if name.ends_with(".pb") {
        return Some(RecordKind::LegacyBlob);
    }
    let suffix = name.rsplit('.').next()?;
    if suffix != "db" {
        return None;
    }
    if name.contains("-wal") || name.contains("-shm") || name.contains("-journal") {
        return None;
    }
    Some(RecordKind::SessionDatabase)
}

fn stem(path: &Path) -> String {
    path.file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Reads the summaries table as `(id, day)` records, or `None` when the
/// database cannot be opened or its shape has moved.
fn read_summary_rows(path: &Path) -> Option<Vec<SessionRecord>> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .ok()?;
    if !has_required_columns(&connection) {
        return None;
    }
    let mut statement = connection
        .prepare(
            "SELECT conversation_id, last_user_input_time, last_modified_time
             FROM conversation_summaries",
        )
        .ok()?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .ok()?;
    let mut records = Vec::new();
    for row in rows.flatten() {
        let (id, input_time, modified_time) = row;
        let day = recorded_day(&input_time).or_else(|| recorded_day(&modified_time));
        records.push(SessionRecord { id, day });
    }
    Some(records)
}

fn has_required_columns(connection: &Connection) -> bool {
    let Ok(mut statement) = connection.prepare("PRAGMA table_info(conversation_summaries)") else {
        return false;
    };
    let Ok(columns) = statement.query_map([], |row| row.get::<_, String>(1)) else {
        return false;
    };
    let present: HashSet<String> = columns.flatten().collect();
    REQUIRED_SUMMARY_COLUMNS
        .iter()
        .all(|column| present.contains(*column))
}

/// The UTC calendar day an Antigravity timestamp names, when it names one.
///
/// Antigravity stores datetimes as text (`2026-11-26 09:12:57.48+00:00`);
/// like the Codex rollout reader, the day is the leading `YYYY-MM-DD`, and a
/// sentinel or malformed time yields nothing rather than a wrong day.
fn recorded_day(timestamp: &str) -> Option<String> {
    let day = &timestamp[..timestamp.len().min(10)];
    if day.len() == 10
        && day.as_bytes()[4] == b'-'
        && day.as_bytes()[7] == b'-'
        && day[..4].parse::<u32>().map(|year| year >= PLAUSIBLE_YEAR) == Ok(true)
    {
        Some(day.to_string())
    } else {
        None
    }
}

/// The UTC calendar day a session file was last modified.
fn modified_day(metadata: &fs::Metadata) -> Option<String> {
    let modified = metadata.modified().ok()?;
    let seconds = if modified >= UNIX_EPOCH {
        modified
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_secs()
            .try_into()
            .ok()?
    } else {
        let before = UNIX_EPOCH.duration_since(modified).ok()?;
        -i64::try_from(before.as_secs()).ok()?
    };
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    (year >= i64::from(PLAUSIBLE_YEAR)).then(|| format!("{year:04}-{month:02}-{day:02}"))
}

/// Converts days since the Unix epoch to a proleptic Gregorian date.
///
/// The repo carries no date-time dependency; this is Howard Hinnant's
/// `civil_from_days` algorithm, the same conversion every date library
/// performs internally.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = (z - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    const SUMMARY_SCHEMA: &str = "CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        step_count INTEGER NOT NULL DEFAULT 0,
        last_modified_time TEXT NOT NULL,
        last_user_input_time TEXT NOT NULL,
        workspace_uris TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT '',
        killed INTEGER NOT NULL DEFAULT 0
    );";

    fn insert_summary(connection: &Connection, id: &str, input_time: &str, modified_time: &str) {
        connection
            .execute(
                "INSERT INTO conversation_summaries
                 (conversation_id, last_user_input_time, last_modified_time)
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![id, input_time, modified_time],
            )
            .expect("insert summary");
    }

    fn write_session_db(dir: &Path, id: &str, modified: Option<SystemTime>) -> PathBuf {
        let path = dir.join(format!("{id}.db"));
        fs::write(&path, b"placeholder").expect("write db");
        if let Some(time) = modified {
            let file = fs::File::options().write(true).open(&path).expect("open");
            file.set_modified(time).expect("set mtime");
        }
        path
    }

    fn epoch_secs(seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(seconds)
    }

    #[test]
    fn civil_from_days_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(20_053), (2024, 11, 26));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(11_017), (2000, 3, 1));
    }

    #[test]
    fn recorded_day_accepts_plausible_timestamps_and_rejects_sentinels() {
        assert_eq!(
            recorded_day("2026-11-26 09:12:57.484336+00:00"),
            Some("2026-11-26".to_string())
        );
        assert_eq!(recorded_day("0001-01-01 00:00:00+00:00"), None);
        assert_eq!(recorded_day("not a timestamp"), None);
        assert_eq!(recorded_day(""), None);
    }

    #[test]
    fn modified_day_reads_the_files_utc_date() {
        let metadata = fs::metadata("/").expect("metadata");
        assert!(modified_day(&metadata).is_some());
    }

    #[test]
    fn summaries_prefer_the_input_time_and_fall_back_to_the_modified_time() {
        let home = std::env::temp_dir().join("antigravity-reader-test-summaries");
        let surface = home.join("antigravity-cli");
        fs::create_dir_all(&surface).expect("surface dir");
        let disk = Connection::open(surface.join(SUMMARIES_DB)).expect("summaries db");
        disk.execute_batch(SUMMARY_SCHEMA).expect("schema");
        insert_summary(
            &disk,
            "a",
            "2026-11-25 10:00:00+00:00",
            "2026-11-26 09:00:00+00:00",
        );
        insert_summary(
            &disk,
            "b",
            "0001-01-01 00:00:00+00:00",
            "2026-11-21 08:00:00+00:00",
        );
        drop(disk);

        let usage = read_sessions(&home).expect("usage");
        assert_eq!(usage.sessions, 2);
        assert_eq!(
            usage
                .session_days
                .iter()
                .map(|day| (day.day.as_str(), day.sessions))
                .collect::<Vec<_>>(),
            vec![("2026-11-21", 1), ("2026-11-25", 1)]
        );
        assert_eq!(usage.first_day.as_deref(), Some("2026-11-21"));
        assert_eq!(usage.last_day.as_deref(), Some("2026-11-25"));
        assert_eq!(usage.files_scanned, 1);
        assert_eq!(usage.files_unreadable, 0);
        assert_eq!(usage.models.len(), 0);
        assert_eq!(usage.days.len(), 0);
        assert_eq!(usage.cost_usd, 0.0);
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn surfaces_without_a_summaries_database_count_their_files() {
        let home = std::env::temp_dir().join("antigravity-reader-test-files");
        fs::create_dir_all(home.join("antigravity-ide/conversations")).expect("ide conversations");
        write_session_db(
            &home.join("antigravity-ide/conversations"),
            "11111111-1111-1111-1111-111111111111",
            Some(epoch_secs(1_764_144_000)),
        );
        let usage = read_sessions(&home).expect("usage");
        assert_eq!(usage.sessions, 1);
        assert_eq!(usage.files_scanned, 1);
        assert!(usage.session_days.len() <= 1);
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_session_already_counted_from_summaries_is_not_counted_twice() {
        let home = std::env::temp_dir().join("antigravity-reader-test-dedupe");
        let surface = home.join("antigravity-cli");
        fs::create_dir_all(surface.join("conversations")).expect("dirs");
        let disk = Connection::open(surface.join(SUMMARIES_DB)).expect("summaries");
        disk.execute_batch(SUMMARY_SCHEMA).expect("schema");
        insert_summary(
            &disk,
            "same-id",
            "2026-11-24 12:00:00+00:00",
            "2026-11-24 12:00:00+00:00",
        );
        drop(disk);
        write_session_db(&surface.join("conversations"), "same-id", None);

        let usage = read_sessions(&home).expect("usage");
        assert_eq!(usage.sessions, 1);
        assert_eq!(usage.files_scanned, 2);
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_sentinel_summary_row_is_dated_by_its_conversation_file() {
        let home = std::env::temp_dir().join("antigravity-reader-test-upgrade");
        let surface = home.join("antigravity-cli");
        fs::create_dir_all(surface.join("conversations")).expect("dirs");
        let disk = Connection::open(surface.join(SUMMARIES_DB)).expect("summaries");
        disk.execute_batch(SUMMARY_SCHEMA).expect("schema");
        insert_summary(
            &disk,
            "sentinel-id",
            "0001-01-01 00:00:00+00:00",
            "0001-01-01 00:00:00+00:00",
        );
        drop(disk);
        write_session_db(
            &surface.join("conversations"),
            "sentinel-id",
            Some(epoch_secs(1_764_144_000)),
        );

        let usage = read_sessions(&home).expect("usage");
        assert_eq!(usage.sessions, 1);
        assert_eq!(usage.session_days.len(), 1);
        assert_eq!(usage.first_day, usage.last_day);
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn every_conversation_file_counts_as_a_session_whatever_its_format() {
        let home = std::env::temp_dir().join("antigravity-reader-test-unreadable");
        let conversations = home.join("antigravity-cli/conversations");
        fs::create_dir_all(&conversations).expect("dirs");
        fs::write(conversations.join("legacy-session.pb"), b"encrypted").expect("blob");
        fs::write(conversations.join("broken.db"), b"not a database").expect("db");

        let usage = read_sessions(&home).expect("usage");
        assert_eq!(usage.sessions, 2);
        assert_eq!(usage.files_unreadable, 0);
        assert_eq!(usage.files_scanned, 2);
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_drifted_summaries_schema_degrades_to_file_counting() {
        let home = std::env::temp_dir().join("antigravity-reader-test-drift");
        let surface = home.join("antigravity-cli");
        fs::create_dir_all(surface.join("conversations")).expect("dirs");
        let drifted = Connection::open(surface.join(SUMMARIES_DB)).expect("summaries");
        drifted
            .execute_batch("CREATE TABLE conversation_summaries (id TEXT PRIMARY KEY);")
            .expect("drifted schema");
        drop(drifted);
        write_session_db(&surface.join("conversations"), "drifted-session", None);

        let usage = read_sessions(&home).expect("usage");
        assert_eq!(usage.sessions, 1);
        assert_eq!(usage.files_unreadable, 1);
        assert_eq!(usage.files_scanned, 2);
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn nothing_on_disk_is_an_absent_record_not_a_zero() {
        let home = std::env::temp_dir().join("antigravity-reader-test-empty");
        fs::create_dir_all(home.join("antigravity-cli")).expect("empty surface");
        assert!(read_sessions(&home).is_none());
        assert!(
            read_sessions(&std::env::temp_dir().join("antigravity-reader-test-missing")).is_none()
        );
        fs::remove_dir_all(&home).ok();
    }
}
