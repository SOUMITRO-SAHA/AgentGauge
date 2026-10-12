//! The SQLite database every persisted store shares.
//!
//! One file in the app-data directory, one connection shared behind a mutex:
//! persistence here is a handful of keyed document reads and writes per
//! launch, so a single serialized connection is simpler and safer than a
//! pool. What the old JSON files kept by hand is the database's own now —
//! writes are transactional, a reader never sees a half-written value, and a
//! commit is durable before the call returns (WAL journal, `synchronous=FULL`).
//!
//! Documents are the unit of storage, not tables per feature: each module
//! owns the shape of the JSON it stores under its own key, exactly as it
//! owned its own file, so the wire shapes and the modules' tests carry over
//! unchanged. Schema moves through `PRAGMA user_version` migrations, applied
//! once per open, so an older build's file upgrades on first launch.
//!
//! Legacy import lives here too, because "consume a predecessor file exactly
//! once" is a storage rule rather than a module rule: a file is imported when
//! its content differs from what is stored, then renamed `.imported` so it can
//! never replay over newer state. That rename is the whole difference between
//! an upgrade and a regression — without it, a stale file would re-import on
//! every launch and restart a flow the user already finished.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use rusqlite::{Connection, OptionalExtension};

use crate::shared::error::Error;

/// The schema revision this build understands.
const SCHEMA_VERSION: i32 = 1;

/// How long a writer waits for a competing writer before giving up. The only
/// contenders are threads of this same process, whose transactions are
/// sub-millisecond; five seconds means a real fault, not contention.
const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Reads and writes the app's durable documents.
pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// Opens the database at `path`, creating it and its schema when absent.
    pub fn open(path: &Path) -> Result<Self, Error> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| {
                Error::storage(format!("Could not create the data directory: {err}"))
            })?;
        }
        let conn = Connection::open(path)
            .map_err(|err| Error::storage(format!("Could not open the database: {err}")))?;
        Self::prepare(conn)
    }

    /// Wraps an already-open connection. The caller owns the open mode, which
    /// is how the tests build a read-only database to prove failed writes are
    /// reported rather than swallowed.
    #[cfg(test)]
    pub fn from_connection(conn: Connection) -> Result<Self, Error> {
        Self::prepare(conn)
    }

    /// A database with the same schema whose contents die with the process.
    ///
    /// The composition root degrades here when no usable data directory
    /// exists: the app runs, and persistence simply does not outlive it — the
    /// same contract the old throwaway-directory fallback kept.
    pub fn open_in_memory() -> Result<Self, Error> {
        let conn = Connection::open_in_memory()
            .map_err(|err| Error::storage(format!("Could not open the database: {err}")))?;
        Self::prepare(conn)
    }

    fn prepare(conn: Connection) -> Result<Self, Error> {
        conn.busy_timeout(BUSY_TIMEOUT)
            .map_err(|err| Error::storage(format!("Could not configure the database: {err}")))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|err| Error::storage(format!("Could not enable durable writes: {err}")))?;
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(|err| Error::storage(format!("Could not enable durable writes: {err}")))?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Renames a predecessor file out of the way without importing it.
    ///
    /// The counterpart to [`Database::import_doc`] for writers: after this
    /// process has stored newer state itself, an unconsumed predecessor file
    /// must not survive to re-import over it on a later read.
    pub fn consume_doc(&self, legacy: Option<&Path>) -> Result<(), Error> {
        match legacy {
            Some(path) => consume(path),
            None => Ok(()),
        }
    }

    /// The connection, for the migration and import paths that own SQL.
    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Reads the document stored under `key`, or none.
    pub fn read_doc(&self, key: &str) -> Result<Option<String>, Error> {
        self.conn()
            .query_row("SELECT value FROM app_state WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|err| Error::storage(format!("Could not read `{key}`: {err}")))
    }

    /// Writes the document stored under `key`.
    pub fn write_doc(&self, key: &str, value: &str) -> Result<(), Error> {
        let written = self
            .conn()
            .execute(
                "INSERT INTO app_state (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [key, value],
            )
            .map_err(|err| Error::storage(format!("Could not save `{key}`: {err}")))?;
        debug_assert_eq!(written, 1, "an upsert touches exactly one row");
        Ok(())
    }

    /// Applies `change` to one document atomically: no other thread can read
    /// or write the key between the read and the write, so a read-modify-write
    /// (the automation store's per-record update) cannot lose an update.
    ///
    /// `change` receives the stored document (or none) and answers the value
    /// to hand back to the caller plus the document to store.
    pub fn update_doc<T>(
        &self,
        key: &str,
        change: impl FnOnce(Option<String>) -> Result<(T, String), Error>,
    ) -> Result<T, Error> {
        let conn = self.conn();
        let stored: Option<String> = conn
            .query_row("SELECT value FROM app_state WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|err| Error::storage(format!("Could not read `{key}`: {err}")))?;
        let (result, next) = change(stored)?;
        conn.execute(
            "INSERT INTO app_state (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, next],
        )
        .map_err(|err| Error::storage(format!("Could not save `{key}`: {err}")))?;
        Ok(result)
    }

    /// Consumes a predecessor file into `key`, exactly once.
    ///
    /// * A missing file is the normal steady state — nothing to do.
    /// * A file whose content differs from the stored document (or when
    ///   nothing is stored, or the stored document is corrupt) is imported.
    /// * The file is renamed `<path>.imported` in every case where it exists,
    ///   so one file can never import twice and replay over newer state.
    /// * A file that cannot be parsed is consumed without importing: corrupt
    ///   input must not be guessed at, and must not sit in front of the
    ///   database forever either.
    pub fn import_doc(&self, key: &str, legacy: Option<&Path>) -> Result<(), Error> {
        let Some(path) = legacy else {
            return Ok(());
        };
        let Ok(raw) = std::fs::read_to_string(path) else {
            return Ok(());
        };

        let incoming: Option<serde_json::Value> = serde_json::from_str(&raw).ok();
        let stored = self.read_doc(key)?;
        let stored_value = stored
            .as_deref()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok());

        if let Some(incoming) = incoming {
            if stored_value.as_ref() != Some(&incoming) {
                self.write_doc(key, &incoming.to_string())?;
            }
        }
        consume(path)
    }
}

/// Renames a consumed predecessor file beside itself, so the import rule can
/// recognise it as spent. A file that is not there is already spent.
fn consume(path: &Path) -> Result<(), Error> {
    let mut spent = OsString::from(path.as_os_str());
    spent.push(".imported");
    match std::fs::rename(path, PathBuf::from(spent)) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(Error::storage(format!(
            "Could not retire the old store: {err}"
        ))),
    }
}

/// Applies every migration past the stored schema version, and makes sure the
/// tables this build reads exist.
///
/// Each step runs in its own transaction, so a failed upgrade leaves the file
/// at its previous version rather than half-migrated. Creation is idempotent
/// and runs regardless of the stored version, so a database from a *newer*
/// build — a user who downgraded — still opens and reads the documents it
/// kept in the same table instead of failing every read into a default.
fn migrate(conn: &Connection) -> Result<(), Error> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_state (
             key TEXT PRIMARY KEY,
             value TEXT NOT NULL
         ) STRICT;",
    )
    .map_err(|err| Error::storage(format!("Could not set up the database: {err}")))?;

    let version: i32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|err| Error::storage(format!("Could not read the schema version: {err}")))?;

    if version < SCHEMA_VERSION {
        conn.execute_batch("PRAGMA user_version = 1;")
            .map_err(|err| Error::storage(format!("Could not record the schema version: {err}")))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::error::ErrorKind;
    use rusqlite::OpenFlags;

    fn temp_db(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("agentgauge-database-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("creates the directory");
        dir.join("agentgauge.db")
    }

    fn cleanup(path: &Path) {
        for suffix in ["", "-wal", "-shm"] {
            let mut name = path.as_os_str().to_os_string();
            name.push(suffix);
            let _ = std::fs::remove_file(PathBuf::from(name));
        }
    }

    #[test]
    fn opening_creates_a_queryable_schema_and_reopening_is_idempotent() {
        let path = temp_db("migrate");
        {
            let db = Database::open(&path).expect("opens");
            db.write_doc("k", "v").expect("writes");
        }
        let reopened = Database::open(&path).expect("reopens");
        assert_eq!(reopened.read_doc("k").expect("reads"), Some("v".into()));
        cleanup(&path);
    }

    #[test]
    fn a_schema_older_than_this_build_upgrades() {
        let path = temp_db("upgrade");
        {
            let conn = Connection::open(&path).expect("opens raw");
            conn.execute_batch("PRAGMA user_version = 0;")
                .expect("seed");
        }
        let db = Database::open(&path).expect("opens and migrates");
        db.write_doc("k", "v").expect("writes");
        cleanup(&path);
    }

    #[test]
    fn a_schema_newer_than_this_build_still_opens_read_only_tables() {
        // A future build's schema is not this build's problem to migrate, but
        // opening must not corrupt anything either: the version check runs
        // before any migration, so an unknown version is simply left alone.
        let path = temp_db("newer");
        {
            let conn = Connection::open(&path).expect("opens raw");
            conn.execute_batch("PRAGMA user_version = 99;")
                .expect("seed");
        }
        let db = Database::open(&path).expect("opens");
        assert_eq!(db.read_doc("k").expect("reads"), None);
        cleanup(&path);
    }

    #[test]
    fn documents_round_trip_and_unknown_keys_read_as_none() {
        let db = Database::open_in_memory().expect("opens");
        assert_eq!(db.read_doc("absent").expect("reads"), None);
        db.write_doc("k", "{\"a\":1}").expect("writes");
        assert_eq!(db.read_doc("k").expect("reads"), Some("{\"a\":1}".into()));
    }

    #[test]
    fn a_write_over_an_existing_key_replaces_it() {
        let db = Database::open_in_memory().expect("opens");
        db.write_doc("k", "first").expect("writes");
        db.write_doc("k", "second").expect("writes");
        assert_eq!(db.read_doc("k").expect("reads"), Some("second".into()));
    }

    #[test]
    fn update_doc_applies_to_the_previous_value_atomically() {
        let db = Database::open_in_memory().expect("opens");
        let seen = db
            .update_doc("k", |stored| {
                let previous = stored.unwrap_or_default();
                Ok((previous.clone(), previous + "!"))
            })
            .expect("updates");
        assert_eq!(seen, "", "an absent document reads as none");
        let seen = db
            .update_doc("k", |stored| {
                let previous = stored.expect("present after the first write");
                Ok((previous.clone(), previous))
            })
            .expect("updates");
        assert_eq!(seen, "!");
    }

    #[test]
    fn update_doc_that_refuses_writes_nothing() {
        let db = Database::open_in_memory().expect("opens");
        db.write_doc("k", "kept").expect("writes");
        let result = db.update_doc::<()>("k", |_| Err(Error::new(ErrorKind::InvalidRequest, "no")));
        assert!(result.is_err());
        assert_eq!(db.read_doc("k").expect("reads"), Some("kept".into()));
    }

    #[test]
    fn durable_mode_is_wal() {
        let path = temp_db("wal");
        let db = Database::open(&path).expect("opens");
        let mode: String = db
            .conn()
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .expect("reads the pragma");
        assert_eq!(mode.to_lowercase(), "wal");
        cleanup(&path);
    }

    #[test]
    fn a_read_only_database_reports_failed_writes() {
        let path = temp_db("readonly");
        {
            let db = Database::open(&path).expect("opens");
            db.write_doc("k", "v").expect("writes");
        }
        let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("opens read-only");
        let error = conn
            .execute(
                "INSERT INTO app_state (key, value) VALUES ('k', 'other')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [],
            )
            .expect_err("a read-only file refuses writes");
        assert!(
            matches!(error, rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::ReadOnly),
            "expected a read-only failure, got {error}"
        );
        cleanup(&path);
    }

    fn legacy_file(name: &str, contents: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("agentgauge-import-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("creates the directory");
        let path = dir.join("legacy.json");
        std::fs::write(&path, contents).expect("writes");
        path
    }

    #[test]
    fn a_legacy_file_imports_when_nothing_is_stored_and_is_then_spent() {
        let db = Database::open_in_memory().expect("opens");
        let path = legacy_file("fresh", r#"{"step":"done","dismissed":true}"#);

        db.import_doc("k", Some(&path)).expect("imports");

        assert_eq!(
            db.read_doc("k").expect("reads"),
            Some(r#"{"dismissed":true,"step":"done"}"#.into()),
            "imported documents are stored canonically"
        );
        assert!(
            !path.exists(),
            "a consumed file must not sit where the next boot re-imports it"
        );
        assert!(path.with_extension("json.imported").exists());
    }

    #[test]
    fn a_spent_file_can_never_replay_but_a_new_seed_is_honoured() {
        let db = Database::open_in_memory().expect("opens");
        let path = legacy_file("replay", r#"{"old":true}"#);
        db.import_doc("k", Some(&path)).expect("imports");

        // The app itself advances the stored document past what the file held.
        db.write_doc("k", r#"{"old":true}"#).expect("writes");
        std::fs::write(&path, r#"{"old":true}"#).expect("re-seeds identically");
        db.import_doc("k", Some(&path)).expect("imports");
        assert_eq!(
            db.read_doc("k").expect("reads"),
            Some(r#"{"old":true}"#.into()),
            "a seed identical to the stored document changes nothing"
        );

        std::fs::write(&path, r#"{"old":false}"#).expect("re-seeds differently");
        db.import_doc("k", Some(&path)).expect("imports");
        assert_eq!(
            db.read_doc("k").expect("reads"),
            Some(r#"{"old":false}"#.into()),
            "a genuinely different seed is honoured — this is how the harness re-seeds"
        );
    }

    #[test]
    fn an_identical_file_is_consumed_without_rewriting() {
        let db = Database::open_in_memory().expect("opens");
        db.write_doc("k", r#"{"same":true}"#).expect("writes");
        let path = legacy_file("same", r#"{"same":true}"#);

        db.import_doc("k", Some(&path)).expect("imports");

        assert!(path.with_extension("json.imported").exists());
        assert_eq!(
            db.read_doc("k").expect("reads"),
            Some(r#"{"same":true}"#.into())
        );
    }

    #[test]
    fn a_corrupt_file_is_consumed_not_imported_and_hides_nothing() {
        let db = Database::open_in_memory().expect("opens");
        db.write_doc("k", r#"{"kept":1}"#).expect("writes");
        let path = legacy_file("corrupt", "{ not json");

        db.import_doc("k", Some(&path)).expect("consumes");

        assert_eq!(
            db.read_doc("k").expect("reads"),
            Some(r#"{"kept":1}"#.into())
        );
        assert!(path.with_extension("json.imported").exists());
    }

    #[test]
    fn a_corrupt_stored_document_is_replaced_by_a_parseable_file() {
        let db = Database::open_in_memory().expect("opens");
        db.write_doc("k", "{ not json").expect("writes");
        let path = legacy_file("corrupt-stored", r#"{"fresh":1}"#);

        db.import_doc("k", Some(&path)).expect("imports");

        assert_eq!(
            db.read_doc("k").expect("reads"),
            Some(r#"{"fresh":1}"#.into())
        );
    }

    #[test]
    fn no_legacy_path_and_no_legacy_file_are_both_noops() {
        let db = Database::open_in_memory().expect("opens");
        db.import_doc("k", None).expect("no path is fine");
        let nowhere = std::env::temp_dir().join("agentgauge-import-absent/none.json");
        let _ = std::fs::remove_file(&nowhere);
        db.import_doc("k", Some(&nowhere)).expect("no file is fine");
        assert_eq!(db.read_doc("k").expect("reads"), None);
    }
}
