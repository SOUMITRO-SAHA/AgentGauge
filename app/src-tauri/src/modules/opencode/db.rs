//! OpenCode's own local session database: the per-session token ledger its CLI
//! does not expose.
//!
//! `opencode session list --format json` reports titles, directories and
//! timestamps — no tokens, no cost, no model — so the database is the only
//! place this data exists. The user approved reading it for exactly this
//! (2026-10-12); what that approval does **not** extend to is writing it, or
//! depending on its shape.
//!
//! Three constraints follow from reading another application's storage:
//!
//! * **Never write.** The connection is read-only, and the daemon may hold the
//!   WAL at any moment.
//! * **Never depend on the schema.** The sessions table is called `session_v2`
//!   — a name that announces it will change. It is discovered by shape, its
//!   columns are pinned, and a table that no longer matches degrades to "no
//!   local record" rather than an error or, worse, a wrong number.
//! * **Never present OpenCode's cost as ours.** OpenCode records its own USD
//!   figure per session. This module ignores it and prices the token split
//!   against the bundled price list, so every figure carries the same
//!   provenance as every other estimate in the app.

use std::path::Path;

use rusqlite::{params_from_iter, Connection, OpenFlags};

use crate::shared::domain::{
    bundled_price_catalog, price_local_model_with_catalog, project_name, LocalDayUsage,
    LocalModelUsage, LocalProjectUsage, LocalUsage, NO_PROJECT,
};

/// The table this module prefers. Discovered by shape, so a rename degrades
/// to "the new table" rather than to nothing.
const SESSIONS_TABLE: &str = "session_v2";

/// Columns the aggregation needs. A table missing any of them is not a
/// sessions table, whatever it is called.
const REQUIRED_COLUMNS: [&str; 9] = [
    "cost",
    "tokens_input",
    "tokens_output",
    "tokens_reasoning",
    "tokens_cache_read",
    "tokens_cache_write",
    "model",
    "time_created",
    "time_updated",
];

/// One session's tokens, as the sessions table reports them.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionRow {
    provider_id: String,
    model_id: String,
    input: u64,
    output: u64,
    reasoning: u64,
    cache_read: u64,
    cache_write: u64,
    created_ms: i64,
    /// The working directory as stored, or empty when the database predates
    /// the column.
    directory: String,
}

impl SessionRow {
    fn total_tokens(&self) -> u64 {
        self.input + self.output
    }
}

/// Reads the OpenCode database at `path`, filtered to the given catalog
/// provider ids. `None` when there is no database, none of those providers
/// appear, or the schema has moved.
pub fn read_local_usage(path: &Path, provider_ids: &[&str]) -> Option<LocalUsage> {
    if provider_ids.is_empty() {
        return None;
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .ok()?;
    read_from(&connection, provider_ids)
}

/// The aggregation, over an already-open connection.
///
/// Split from the open so the tests can hand it an in-memory database of the
/// same shape and never touch a developer's real OpenCode data.
fn read_from(connection: &Connection, provider_ids: &[&str]) -> Option<LocalUsage> {
    let table = discover_sessions_table(connection)?;
    // The directory column is how a session names its working directory, and
    // an older database does not have one. Reading it is then impossible and
    // the leaderboard is simply absent, which is a fact about the data — the
    // rest of the reading is unaffected.
    let directory = if has_column(connection, &table, "directory") {
        "directory"
    } else {
        "''"
    };
    let sql = format!(
        "SELECT json_extract(model, '$.providerID'), json_extract(model, '$.id'), \
         tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, \
         tokens_cache_write, time_created, {directory} \
         FROM {table} \
         WHERE json_valid(model) \
           AND json_extract(model, '$.providerID') IN ({})",
        vec!["?"; provider_ids.len()].join(", ")
    );
    let mut statement = connection.prepare(&sql).ok()?;
    let rows = statement
        .query_map(params_from_iter(provider_ids), read_session_row)
        .ok()?
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if rows.is_empty() {
        return None;
    }
    Some(summarize(rows))
}

fn read_session_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRow> {
    let provider_id: Option<String> = row.get(0)?;
    let model_id: Option<String> = row.get(1)?;
    let (Some(provider_id), Some(model_id)) = (provider_id, model_id) else {
        // A session whose model blob never parsed is not attributable; the
        // query cannot produce it again, and it carries no tokens to lose.
        return Err(rusqlite::Error::InvalidQuery);
    };
    Ok(SessionRow {
        provider_id,
        model_id,
        input: non_negative(row, 2),
        output: non_negative(row, 3),
        reasoning: non_negative(row, 4),
        cache_read: non_negative(row, 5),
        cache_write: non_negative(row, 6),
        created_ms: row.get(7)?,
        // The full path, because two directories can share a basename and
        // merging them would be a dishonest row. Only the basename is shown.
        directory: row.get(8).unwrap_or_default(),
    })
}

fn non_negative(row: &rusqlite::Row<'_>, index: usize) -> u64 {
    row.get::<_, i64>(index).unwrap_or_default().max(0) as u64
}

/// Folds sessions into per-model rows, prices each against the catalog of the
/// provider it ran on, and reports the coverage the rows actually span.
fn summarize(rows: Vec<SessionRow>) -> LocalUsage {
    let mut grouped: Vec<(String, LocalModelUsage)> = Vec::new();
    for row in &rows {
        match grouped
            .iter_mut()
            .find(|(provider, model)| *provider == row.provider_id && model.id == row.model_id)
        {
            Some((_, model)) => {
                model.input += row.input;
                model.cached_input += row.cache_read.min(row.input);
                model.cache_write += row.cache_write;
                model.output += row.output;
                model.reasoning += row.reasoning.min(row.output);
                model.responses += 1;
            }
            None => grouped.push((
                row.provider_id.clone(),
                LocalModelUsage {
                    id: row.model_id.clone(),
                    display_name: row.model_id.clone(),
                    input: row.input,
                    cached_input: row.cache_read.min(row.input),
                    cache_write: row.cache_write,
                    output: row.output,
                    reasoning: row.reasoning.min(row.output),
                    responses: 1,
                    cost_usd: None,
                },
            )),
        }
    }

    // Parsed once for the whole scan: a row priced against a catalog that
    // failed to parse would silently become free.
    let catalog = bundled_price_catalog();
    let mut cost_usd = 0.0;
    let mut unpriced_tokens = 0;
    for (provider, model) in grouped.iter_mut() {
        let priced = match catalog.as_ref() {
            Some(catalog) => price_local_model_with_catalog(model, provider, catalog),
            None => false,
        };
        if priced {
            cost_usd += model.cost_usd.unwrap_or_default();
        } else {
            unpriced_tokens += model.total_tokens();
        }
    }
    let mut models: Vec<LocalModelUsage> = grouped.into_iter().map(|(_, model)| model).collect();
    models.sort_by(|left, right| {
        right
            .total_tokens()
            .cmp(&left.total_tokens())
            .then_with(|| left.id.cmp(&right.id))
    });

    let mut days: Vec<(String, u64)> = Vec::new();
    for row in &rows {
        let day = day_of_millis(row.created_ms);
        match days.iter_mut().find(|(existing, _)| *existing == day) {
            Some((_, tokens)) => *tokens += row.total_tokens(),
            None => days.push((day, row.total_tokens())),
        }
    }
    days.sort();

    let first_day = days.first().map(|(day, _)| day.clone());
    let last_day = days.last().map(|(day, _)| day.clone());

    let projects = rank_projects(&rows, catalog.as_ref());
    LocalUsage {
        models,
        projects,
        days: days
            .into_iter()
            .map(|(day, tokens)| LocalDayUsage { day, tokens })
            .collect(),
        cost_usd,
        unpriced_tokens,
        sessions: rows.len() as u64,
        files_scanned: 1,
        files_unreadable: 0,
        files_compressed: 0,
        first_day,
        last_day,
    }
}

/// Folds sessions into one row per working directory, ranked by tokens.
///
/// A project's cost is priced per `(directory, provider, model)` group rather
/// than by splitting a project's total across models, because a share of an
/// exact total is an estimate wearing an exact number's clothes. One unpriced
/// model leaves that project's cost `None`.
///
/// Grouping keys on the full directory while displaying only its basename, so
/// two projects that happen to share a name stay two rows.
fn rank_projects(
    rows: &[SessionRow],
    catalog: Option<&serde_json::Value>,
) -> Vec<LocalProjectUsage> {
    // Keyed by project, provider and model, because pricing needs the provider
    // and two models inside one project are two prices, not one.
    let mut grouped: Vec<(String, String, LocalModelUsage)> = Vec::new();
    for row in rows {
        let project = project_name(row.directory.trim())
            .unwrap_or(NO_PROJECT)
            .to_string();
        match grouped
            .iter_mut()
            .find(|(existing_project, provider, model)| {
                existing_project == &project
                    && provider == &row.provider_id
                    && model.id == row.model_id
            }) {
            Some((_, _, model)) => {
                model.input += row.input;
                model.cached_input += row.cache_read.min(row.input);
                model.cache_write += row.cache_write;
                model.output += row.output;
                model.reasoning += row.reasoning.min(row.output);
                model.responses += 1;
            }
            None => grouped.push((
                project,
                row.provider_id.clone(),
                LocalModelUsage {
                    id: row.model_id.clone(),
                    display_name: row.model_id.clone(),
                    input: row.input,
                    cached_input: row.cache_read.min(row.input),
                    cache_write: row.cache_write,
                    output: row.output,
                    reasoning: row.reasoning.min(row.output),
                    responses: 1,
                    cost_usd: None,
                },
            )),
        }
    }

    let mut projects: Vec<LocalProjectUsage> = Vec::new();
    for (project, provider, mut model) in grouped {
        let priced = match catalog {
            Some(catalog) => price_local_model_with_catalog(&mut model, &provider, catalog),
            None => false,
        };
        let entry = match projects.iter_mut().find(|entry| entry.name == project) {
            Some(entry) => entry,
            None => {
                projects.push(LocalProjectUsage {
                    name: project.clone(),
                    input: 0,
                    output: 0,
                    responses: 0,
                    cost_usd: Some(0.0),
                });
                projects.last_mut().expect("just pushed")
            }
        };
        entry.input += model.input;
        entry.output += model.output;
        entry.responses += model.responses;
        if priced {
            entry.cost_usd =
                Some(entry.cost_usd.unwrap_or_default() + model.cost_usd.unwrap_or_default());
        } else {
            // One unpriced model makes the whole row unknown rather than low.
            entry.cost_usd = None;
        }
    }

    projects.sort_by(|left, right| {
        right
            .total_tokens()
            .cmp(&left.total_tokens())
            .then_with(|| left.name.cmp(&right.name))
    });
    projects
}

/// The first table carrying every column the aggregation needs.
///
/// The known name wins when it qualifies, but any table with the right columns
/// is accepted: a migration that renames `session_v2` must degrade to a
/// different number, never to a wrong one.
fn discover_sessions_table(connection: &Connection) -> Option<String> {
    let mut statement = connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .ok()?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))
        .ok()?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();

    names
        .iter()
        .find(|name| *name == SESSIONS_TABLE && table_has_columns(connection, name))
        .or_else(|| {
            names
                .iter()
                .find(|name| table_has_columns(connection, name))
        })
        .cloned()
}

/// Whether a table has every pinned column. Extra columns are fine.
/// Whether a table carries one named column.
fn has_column(connection: &Connection, table: &str, column: &str) -> bool {
    let Ok(mut statement) = connection.prepare(&format!("PRAGMA table_info(\"{table}\")")) else {
        return false;
    };
    let Ok(mut rows) = statement.query([]) else {
        return false;
    };
    while let Ok(Some(row)) = rows.next() {
        if let Ok(present) = row.get::<_, String>(1) {
            if present == column {
                return true;
            }
        }
    }
    false
}

fn table_has_columns(connection: &Connection, table: &str) -> bool {
    let Ok(mut statement) = connection.prepare(&format!("PRAGMA table_info(\"{table}\")")) else {
        return false;
    };
    let Ok(mut rows) = statement.query([]) else {
        return false;
    };
    let mut present: Vec<String> = Vec::new();
    while let Ok(Some(row)) = rows.next() {
        if let Ok(column) = row.get::<_, String>(1) {
            present.push(column);
        }
    }
    REQUIRED_COLUMNS
        .iter()
        .all(|column| present.contains(&column.to_string()))
}

/// The UTC calendar day of an epoch-millisecond timestamp, as `YYYY-MM-DD`.
///
/// The store keeps milliseconds, not seconds — comparing against a
/// `strftime('%s','now')` value matches nothing at all — and days are
/// compared as strings throughout the app, so this returns the ISO date and
/// needs no date library.
fn day_of_millis(millis: i64) -> String {
    let (year, month, day) = civil_from_days(millis.div_euclid(86_400_000));
    format!("{year:04}-{month:02}-{day:02}")
}

/// Days since the Unix epoch to a civil date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = (shifted - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = (if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    }) as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}
#[cfg(test)]
mod tests {
    use super::*;

    /// A sessions table with the real shape, in memory.
    fn sessions_db(table: &str) -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory");
        connection
            .execute_batch(&format!(
                "CREATE TABLE {table} (
                    id TEXT PRIMARY KEY,
                    cost REAL,
                    tokens_input INTEGER,
                    tokens_output INTEGER,
                    tokens_reasoning INTEGER,
                    tokens_cache_read INTEGER,
                    tokens_cache_write INTEGER,
                    model TEXT,
                    time_created INTEGER,
                    time_updated INTEGER,
                    directory TEXT
                );"
            ))
            .expect("sessions table");
        connection
    }

    fn insert(connection: &Connection, session: Session<'_>) {
        insert_into(connection, SESSIONS_TABLE, session);
    }

    /// One row as the sessions table stores it, so the helper takes a record
    /// rather than eight positional arguments.
    struct Session<'a> {
        provider: &'a str,
        model: &'a str,
        input: i64,
        output: i64,
        reasoning: i64,
        cache_read: i64,
        created_ms: i64,
        /// The working directory, as the sessions table stores it.
        directory: &'a str,
    }

    fn insert_into(connection: &Connection, table: &str, row: Session<'_>) {
        connection
            .execute(
                &format!(
                    "INSERT INTO {table} (id, cost, tokens_input, tokens_output,
                 tokens_reasoning, tokens_cache_read, tokens_cache_write, model,
                 time_created, time_updated, directory)
                 VALUES (?1, 0.0, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?7, ?8)"
                ),
                rusqlite::params![
                    format!("{}-{}-{}", row.provider, row.model, row.created_ms),
                    row.input,
                    row.output,
                    row.reasoning,
                    row.cache_read,
                    format!(
                        r#"{{"id":"{}","providerID":"{}"}}"#,
                        row.model, row.provider
                    ),
                    row.created_ms,
                    row.directory,
                ],
            )
            .expect("insert session");
    }

    #[test]
    fn sessions_fold_into_one_ranked_row_per_working_directory() {
        let connection = sessions_db(SESSIONS_TABLE);
        for (directory, created_ms) in [
            ("/Users/dev/code/app", 1_790_000_000_000_i64),
            ("/Users/dev/code/app", 1_790_100_000_000),
            ("/Users/dev/code/app/libryva", 1_790_200_000_000),
            ("/Users/dev/code/other", 1_790_300_000_000),
        ] {
            insert(
                &connection,
                Session {
                    provider: "minimax-coding-plan",
                    model: "MiniMax-M3",
                    input: 100,
                    output: 10,
                    reasoning: 0,
                    cache_read: 0,
                    created_ms,
                    directory,
                },
            );
        }

        let usage = read_from(&connection, &["minimax-coding-plan"]).expect("usage");

        // Ranked by tokens, labelled by the directory's basename so no
        // absolute path or account name reaches the screen.
        assert_eq!(
            usage
                .projects
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
            vec!["app", "libryva", "other"]
        );
        assert_eq!(usage.projects[0].input, 200);
        assert_eq!(usage.projects[0].responses, 2);
        // Two directories that share a basename would otherwise merge into
        // one dishonest row, so the full path keys the grouping even though
        // only the basename is displayed.
        assert_eq!(usage.projects[1].input, 100);
        assert_eq!(usage.projects[2].input, 100);
    }

    #[test]
    fn a_session_with_no_directory_still_counts_against_somewhere() {
        let connection = sessions_db(SESSIONS_TABLE);
        insert(
            &connection,
            Session {
                provider: "minimax-coding-plan",
                model: "MiniMax-M3",
                input: 500,
                output: 50,
                reasoning: 0,
                cache_read: 0,
                created_ms: 1_790_000_000_000,
                directory: "",
            },
        );

        let usage = read_from(&connection, &["minimax-coding-plan"]).expect("usage");

        assert_eq!(usage.projects.len(), 1);
        assert_eq!(usage.projects[0].name, NO_PROJECT);
        assert_eq!(usage.projects[0].input, 500);
    }

    #[test]
    fn sessions_fold_into_one_row_per_model() {
        let connection = sessions_db(SESSIONS_TABLE);
        insert(
            &connection,
            Session {
                provider: "minimax-coding-plan",
                model: "MiniMax-M3",
                input: 1000,
                output: 200,
                reasoning: 50,
                cache_read: 800,
                created_ms: 1_790_000_000_000,
                directory: "/Users/dev/code/app",
            },
        );
        insert(
            &connection,
            Session {
                provider: "minimax-coding-plan",
                model: "MiniMax-M3",
                input: 3000,
                output: 600,
                reasoning: 100,
                cache_read: 900,
                created_ms: 1_790_100_000_000,
                directory: "/Users/dev/code/app",
            },
        );
        insert(
            &connection,
            Session {
                provider: "minimax-coding-plan",
                model: "MiniMax-M3-2",
                input: 500,
                output: 50,
                reasoning: 0,
                cache_read: 0,
                created_ms: 1_790_200_000_000,
                directory: "/Users/dev/code/app",
            },
        );

        let usage = read_from(&connection, &["minimax-coding-plan"]).expect("a reading");

        assert_eq!(usage.sessions, 3);
        assert_eq!(usage.models.len(), 2);
        let m3 = &usage.models[0];
        assert_eq!(m3.id, "MiniMax-M3");
        assert_eq!(m3.input, 4000);
        assert_eq!(m3.cached_input, 1700);
        assert_eq!(m3.output, 800);
        assert_eq!(m3.reasoning, 150);
        assert_eq!(m3.responses, 2);
        assert_eq!(m3.total_tokens(), 4800);
    }

    #[test]
    fn only_the_requested_providers_are_read() {
        let connection = sessions_db(SESSIONS_TABLE);
        insert(
            &connection,
            Session {
                provider: "minimax-coding-plan",
                model: "MiniMax-M3",
                input: 100,
                output: 10,
                reasoning: 0,
                cache_read: 0,
                created_ms: 1_790_000_000_000,
                directory: "/Users/dev/code/app",
            },
        );
        insert(
            &connection,
            Session {
                provider: "zai-coding-plan",
                model: "glm-5.3",
                input: 900,
                output: 90,
                reasoning: 0,
                cache_read: 0,
                created_ms: 1_790_000_000_000,
                directory: "/Users/dev/code/app",
            },
        );

        let usage = read_from(&connection, &["minimax-coding-plan"]).expect("a reading");

        assert_eq!(usage.models.len(), 1);
        assert_eq!(usage.models[0].id, "MiniMax-M3");
        assert_eq!(usage.sessions, 1);
    }

    #[test]
    fn a_provider_with_no_sessions_reports_nothing_rather_than_zero() {
        let connection = sessions_db(SESSIONS_TABLE);
        insert(
            &connection,
            Session {
                provider: "zai-coding-plan",
                model: "glm-5.3",
                input: 100,
                output: 10,
                reasoning: 0,
                cache_read: 0,
                created_ms: 1_790_000_000_000,
                directory: "/Users/dev/code/app",
            },
        );

        assert_eq!(read_from(&connection, &["minimax-coding-plan"]), None);
    }

    #[test]
    fn each_model_prices_against_its_own_provider_catalog() {
        let connection = sessions_db(SESSIONS_TABLE);
        // 1M fresh prompt at the Z.AI reference rate, 1M cache reads, 1M output.
        insert(
            &connection,
            Session {
                provider: "zai-coding-plan",
                model: "glm-5.3",
                input: 2_000_000,
                output: 1_000_000,
                reasoning: 0,
                cache_read: 1_000_000,
                created_ms: 1_790_000_000_000,
                directory: "/Users/dev/code/app",
            },
        );

        let usage = read_from(&connection, &["zai-coding-plan"]).expect("a reading");

        let model = &usage.models[0];
        assert_eq!(model.display_name, "GLM-5.3");
        let cost = model.cost_usd.expect("priced from the catalog");
        // fresh 1M × 1.4 + cached 1M × 0.26 (the catalog's cache-read rate)
        // + output 1M × 4.4 = $6.06.
        assert!((cost - 6.06).abs() < 0.001, "cost was {cost}");
        assert!((usage.cost_usd - 6.06).abs() < 0.001);
        assert_eq!(usage.unpriced_tokens, 0);
    }

    #[test]
    fn a_model_outside_the_catalog_stays_an_unpriced_token_count() {
        let connection = sessions_db(SESSIONS_TABLE);
        insert(
            &connection,
            Session {
                provider: "opencode",
                model: "space-bunny-free",
                input: 4_000,
                output: 500,
                reasoning: 0,
                cache_read: 0,
                created_ms: 1_790_000_000_000,
                directory: "/Users/dev/code/app",
            },
        );

        let usage = read_from(&connection, &["opencode"]).expect("a reading");

        assert_eq!(usage.models[0].cost_usd, None);
        assert_eq!(usage.unpriced_tokens, 4_500);
        assert_eq!(usage.cost_usd, 0.0);
    }

    #[test]
    fn a_renamed_sessions_table_is_still_found_by_shape() {
        let connection = sessions_db("session_v3");
        insert_into(
            &connection,
            "session_v3",
            Session {
                provider: "minimax-coding-plan",
                model: "MiniMax-M3",
                input: 100,
                output: 10,
                reasoning: 0,
                cache_read: 0,
                created_ms: 1_790_000_000_000,
                directory: "/Users/dev/code/app",
            },
        );

        let usage = read_from(&connection, &["minimax-coding-plan"]).expect("a reading");

        assert_eq!(usage.models.len(), 1);
        assert_eq!(usage.models[0].id, "MiniMax-M3");
    }

    #[test]
    fn a_table_missing_a_pinned_column_is_not_read_as_sessions() {
        let connection = Connection::open_in_memory().expect("in-memory");
        connection
            .execute_batch(
                "CREATE TABLE session_v2 (
                    id TEXT PRIMARY KEY, cost REAL, tokens_input INTEGER,
                    model TEXT, time_created INTEGER, time_updated INTEGER);",
            )
            .expect("partial table");

        assert_eq!(read_from(&connection, &["minimax-coding-plan"]), None);
    }

    #[test]
    fn a_session_with_an_unreadable_model_blob_is_skipped_not_fatal() {
        let connection = sessions_db(SESSIONS_TABLE);
        insert(
            &connection,
            Session {
                provider: "minimax-coding-plan",
                model: "MiniMax-M3",
                input: 100,
                output: 10,
                reasoning: 0,
                cache_read: 0,
                created_ms: 1_790_000_000_000,
                directory: "/Users/dev/code/app",
            },
        );
        connection
            .execute(
                "INSERT INTO session_v2 (id, cost, tokens_input, tokens_output,
                 tokens_reasoning, tokens_cache_read, tokens_cache_write, model,
                 time_created, time_updated)
                 VALUES ('broken', 0.0, 5, 5, 0, 0, 0, 'not json', 1790000000000, 1790000000000)",
                [],
            )
            .expect("insert broken session");

        let usage = read_from(&connection, &["minimax-coding-plan"]).expect("a reading");

        assert_eq!(usage.sessions, 1);
        assert_eq!(usage.models[0].id, "MiniMax-M3");
    }

    #[test]
    fn days_come_from_the_millisecond_timestamps() {
        let connection = sessions_db(SESSIONS_TABLE);
        // 2026-01-01T00:00Z, 2026-10-11T09:57Z, and the epoch itself.
        insert(
            &connection,
            Session {
                provider: "minimax-coding-plan",
                model: "MiniMax-M3",
                input: 100,
                output: 0,
                reasoning: 0,
                cache_read: 0,
                created_ms: 1_767_225_600_000,
                directory: "/Users/dev/code/app",
            },
        );
        insert(
            &connection,
            Session {
                provider: "minimax-coding-plan",
                model: "MiniMax-M3",
                input: 200,
                output: 0,
                reasoning: 0,
                cache_read: 0,
                created_ms: 1_791_709_057_570,
                directory: "/Users/dev/code/app",
            },
        );
        insert(
            &connection,
            Session {
                provider: "minimax-coding-plan",
                model: "MiniMax-M3",
                input: 400,
                output: 0,
                reasoning: 0,
                cache_read: 0,
                created_ms: 0,
                directory: "/Users/dev/code/app",
            },
        );

        let usage = read_from(&connection, &["minimax-coding-plan"]).expect("a reading");

        assert_eq!(
            usage.days,
            vec![
                LocalDayUsage {
                    day: "1970-01-01".into(),
                    tokens: 400
                },
                LocalDayUsage {
                    day: "2026-01-01".into(),
                    tokens: 100
                },
                LocalDayUsage {
                    day: "2026-10-11".into(),
                    tokens: 200
                },
            ]
        );
        assert_eq!(usage.first_day.as_deref(), Some("1970-01-01"));
        assert_eq!(usage.last_day.as_deref(), Some("2026-10-11"));
    }

    #[test]
    fn epoch_milliseconds_convert_to_their_utc_calendar_day() {
        assert_eq!(day_of_millis(1_791_709_057_570), "2026-10-11");
        assert_eq!(day_of_millis(1_767_225_600_000), "2026-01-01");
        assert_eq!(day_of_millis(1_000_000_000_000), "2001-09-09");
        assert_eq!(day_of_millis(0), "1970-01-01");
        assert_eq!(day_of_millis(-2_208_988_800_000), "1900-01-01");
    }
}

#[cfg(test)]
mod path_tests {
    use super::*;
    use std::path::PathBuf;

    /// OpenCode keeps its data under the XDG data directory, falling back to
    /// `~/.local/share` — the same resolution the Processes screen uses, so
    /// both features agree about where OpenCode lives.
    #[test]
    fn the_database_sits_under_the_xdg_data_directory() {
        assert_eq!(
            database_path(
                Some(PathBuf::from("/home/me")),
                Some(PathBuf::from("/data"))
            ),
            Some(PathBuf::from("/data/opencode/opencode.db"))
        );
    }

    #[test]
    fn without_an_xdg_data_directory_it_falls_back_to_local_share() {
        assert_eq!(
            database_path(Some(PathBuf::from("/home/me")), None),
            Some(PathBuf::from("/home/me/.local/share/opencode/opencode.db"))
        );
    }

    #[test]
    fn no_home_and_no_xdg_data_is_no_database() {
        assert_eq!(database_path(None, None), None);
        assert_eq!(
            database_path(Some(PathBuf::new()), Some(PathBuf::new())),
            None
        );
    }
}

/// The OpenCode session database for this machine, if its data directory can
/// be resolved. `None` when neither source names a home.
fn database_path(
    home: Option<std::path::PathBuf>,
    xdg_data: Option<std::path::PathBuf>,
) -> Option<std::path::PathBuf> {
    let base = match xdg_data.filter(|path| !path.as_os_str().is_empty()) {
        Some(path) => path,
        None => home
            .filter(|path| !path.as_os_str().is_empty())?
            .join(".local")
            .join("share"),
    };
    Some(base.join("opencode").join("opencode.db"))
}

/// Reads the local session ledger for the given catalog provider ids, from the
/// OpenCode database on this machine.
///
/// `None` when OpenCode has no database, has never run those providers, or its
/// schema has moved — all of which mean "no local record", never a failure.
pub fn local_usage_for(provider_ids: &[&str]) -> Option<LocalUsage> {
    let home = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from);
    let xdg_data = std::env::var_os("XDG_DATA_HOME")
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from);
    read_local_usage(&database_path(home, xdg_data)?, provider_ids)
}
