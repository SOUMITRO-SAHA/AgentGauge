//! Persisted usage statistics: one row per (provider, lens, UTC day).
//!
//! Why this exists: a cold start had nothing to show. Every figure on the Stats
//! tab came straight off a network read, so opening the app meant skeletons
//! until the slowest provider answered, and a provider that was down meant no
//! history at all. Storing each day's totals makes the database the thing the
//! screen renders from first, with the network a later correction.
//!
//! The shape is deliberately narrow. One row per provider, per *lens*, per UTC
//! day — nothing per fetch, nothing per session, no JSON blobs. A refresh that
//! re-reports a day therefore **corrects** that row instead of appending a
//! duplicate, which is what keeps the table bounded however often the app polls:
//! a year of hourly polling stores the same rows as a year of daily polling.
//!
//! The lens is part of the key, not a column to be filtered later, because the
//! two lenses are different quantities that must never be summed. `Account` is
//! what the provider's own API reports; `Local` is what the app derived from the
//! user's harness files. Codex publishes both at once, so a key without the lens
//! would silently double its token counts.
//!
//! Filtering lives here rather than in the renderer. Every read takes an
//! inclusive `[from, to]` day range and answers both the sparse series and the
//! aggregates the cards need, so a "90 days" view costs what a "today" view
//! costs no matter how much history is stored, and the renderer never receives a
//! row outside the range it asked for.
//!
//! Cost is never stored. Dollars are recomputed at read time from the tokens
//! here and the current price list, so a price-list correction reaches history
//! instead of being frozen into a row that can never be right twice.

use std::collections::BTreeMap;
use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension};

use crate::shared::clock;
use crate::shared::database::Database;
use crate::shared::domain::ProviderKind;
use crate::shared::error::Error;

/// How many days of history is kept. A range older than this has been pruned,
/// so the UI must report its coverage rather than promise an empty decade.
pub const RETENTION_DAYS: i64 = 730;

/// Which lens a stored row came from.
///
/// Stored as the bare lowercase word so the value is readable in any SQL client,
/// and pinned by a `CHECK` so an unknown lens cannot be written at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatsSource {
    /// What the provider's own API reported.
    Account,
    /// What the app derived from the user's own harness files.
    Local,
}

impl StatsSource {
    pub fn as_str(self) -> &'static str {
        match self {
            StatsSource::Account => "account",
            StatsSource::Local => "local",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "account" => Some(StatsSource::Account),
            "local" => Some(StatsSource::Local),
            _ => None,
        }
    }
}

/// One provider-reported day for one lens.
///
/// Every counter but `tokens` is optional because providers genuinely differ:
/// Codex's account read counts no per-day requests and Kimi publishes no cache
/// split at all. `None` means "the provider did not report this" and must never
/// render as zero.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DayStat {
    pub day: String,
    pub tokens: u64,
    pub requests: Option<u64>,
    pub prompt_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

/// One model's share of one day.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ModelDayStat {
    pub day: String,
    pub model_id: String,
    pub tokens: u64,
    pub requests: Option<u64>,
}

/// One day's session count, for the harness-session series.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SessionDayStat {
    pub day: String,
    pub sessions: u64,
}

/// Everything one refresh learned about a provider and lens.
///
/// Taken as a whole so a refresh is one transaction: a reader never sees a day
/// series from one fetch beside a coverage stamp from another.
#[derive(Debug, Clone)]
pub struct ReadingInput {
    pub provider: ProviderKind,
    pub source: StatsSource,
    /// Epoch ms of the fetch that produced this reading.
    pub fetched_at: i64,
    pub days: Vec<DayStat>,
    pub model_days: Vec<ModelDayStat>,
    pub session_days: Vec<SessionDayStat>,
    /// The prompt/cache figures a provider published for its **whole window**,
    /// kept beside the daily rows rather than inside one. They are a property of
    /// the window, not of any day, and the fallback when no day carries a split.
    pub window_prompt_tokens: Option<u64>,
    pub window_cached_tokens: Option<u64>,
    pub window_hit_rate: Option<f64>,
    /// The headline figure a provider reports for its whole window or lifetime.
    /// Never summed with the daily rows: Codex's is a lifetime figure beside a
    /// 43-day series.
    pub headline_tokens: Option<u64>,
    pub headline_requests: Option<u64>,
    /// How many days the provider's own window covers, when it reports one.
    pub window_days: Option<u64>,
}

impl ReadingInput {
    /// A reading with no figures yet — every provider, lens and day is required,
    /// so there is no honest default for them.
    pub fn new(provider: ProviderKind, source: StatsSource, fetched_at: i64) -> Self {
        Self {
            provider,
            source,
            fetched_at,
            days: Vec::new(),
            model_days: Vec::new(),
            session_days: Vec::new(),
            window_prompt_tokens: None,
            window_cached_tokens: None,
            window_hit_rate: None,
            headline_tokens: None,
            headline_requests: None,
            window_days: None,
        }
    }
}

/// What is actually stored for a provider and lens.
///
/// `PartialEq` but not `Eq`: `window_hit_rate` is a vendor-published fraction, so
/// two coverages can differ in the last bit and still mean the same thing. Not
/// `Default` either — a coverage belongs to a provider and lens, and defaulting
/// those would attribute stored history to whichever provider sorts first.
#[derive(Debug, Clone, PartialEq)]
pub struct Coverage {
    pub provider: ProviderKind,
    pub source: StatsSource,
    pub last_fetched_at: Option<i64>,
    /// The oldest and newest stored day, so the UI can say what a range can be
    /// filled from instead of implying every requested day exists.
    pub first_day: Option<String>,
    pub last_day: Option<String>,
    /// The oldest day not yet stored, for a provider that caps a single request's
    /// window and must be walked backwards in chunks.
    pub backfill_cursor: Option<String>,
    pub headline_tokens: Option<u64>,
    pub headline_requests: Option<u64>,
    pub window_days: Option<u64>,
    pub window_prompt_tokens: Option<u64>,
    pub window_cached_tokens: Option<u64>,
    pub window_hit_rate: Option<f64>,
}

impl Coverage {
    /// Nothing stored for this provider and lens yet — which is a real answer
    /// the UI can show, not a failure to read.
    pub fn empty(provider: ProviderKind, source: StatsSource) -> Self {
        Self {
            provider,
            source,
            last_fetched_at: None,
            first_day: None,
            last_day: None,
            backfill_cursor: None,
            headline_tokens: None,
            headline_requests: None,
            window_days: None,
            window_prompt_tokens: None,
            window_cached_tokens: None,
            window_hit_rate: None,
        }
    }
}

/// One row of the stored daily series.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DayRow {
    pub day: String,
    pub tokens: u64,
    pub requests: Option<u64>,
    pub prompt_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub sessions: Option<u64>,
}

/// One row of the per-model daily series.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelDayRow {
    pub day: String,
    pub model_id: String,
    pub tokens: u64,
    pub requests: Option<u64>,
}

/// A model's total across the queried range, summed by the database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelTotal {
    pub model_id: String,
    pub tokens: u64,
    pub requests: Option<u64>,
}

/// Range totals, aggregated in SQL rather than by the renderer.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RangeTotals {
    pub tokens: u64,
    pub requests: Option<u64>,
    pub sessions: Option<u64>,
    pub peak_daily_tokens: Option<u64>,
    /// Prompt and cached totals across the range, for the cache card.
    pub prompt_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
}

/// Everything one range needs, answered in a single round trip.
#[derive(Debug, Clone, PartialEq)]
pub struct RangeReport {
    pub provider: ProviderKind,
    pub source: StatsSource,
    pub from: String,
    pub to: String,
    pub totals: RangeTotals,
    pub days: Vec<DayRow>,
    pub model_days: Vec<ModelDayRow>,
    pub models: Vec<ModelTotal>,
    pub coverage: Coverage,
}

/// The stored usage statistics, over the shared database.
pub struct StatsStore {
    database: Arc<Database>,
}

impl StatsStore {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }

    /// Stores one provider reading, atomically, and prunes past retention.
    pub fn record(&self, input: ReadingInput) -> Result<Coverage, Error> {
        let conn = self.database.lock();
        let txn = conn
            .unchecked_transaction()
            .map_err(|err| storage_error("Could not store usage stats", err))?;

        for day in &input.days {
            upsert_day(&txn, input.provider, input.source, day)?;
        }
        for model_day in &input.model_days {
            upsert_model_day(&txn, input.provider, input.source, model_day)?;
        }
        for session_day in &input.session_days {
            upsert_session_day(&txn, input.provider, input.source, session_day)?;
        }
        // Prune before recording coverage, not after: coverage is read back from
        // the rows themselves, so recording it first would stamp a `first_day`
        // for a day this very write is about to delete.
        let floor = retention_floor(input.fetched_at);
        prune(&txn, &floor)?;
        let coverage = record_coverage(&txn, &input)?;

        txn.commit()
            .map_err(|err| storage_error("Could not store usage stats", err))?;
        Ok(coverage)
    }

    /// Reads one inclusive day range, filtered and aggregated by the database.
    pub fn range(
        &self,
        provider: ProviderKind,
        source: StatsSource,
        from: &str,
        to: &str,
    ) -> Result<RangeReport, Error> {
        let conn = self.database.lock();
        let key = rusqlite::params![provider.as_str(), source.as_str(), from, to,];

        let mut days = query_rows(
            &conn,
            "SELECT day, tokens, requests, prompt_tokens, cached_tokens, output_tokens
             FROM stats_day
             WHERE provider = ?1 AND source = ?2 AND day >= ?3 AND day <= ?4
             ORDER BY day",
            key,
            |row| {
                Ok(DayRow {
                    day: row.get(0)?,
                    tokens: read_u64(row, 1)?,
                    requests: read_opt_u64(row, 2)?,
                    prompt_tokens: read_opt_u64(row, 3)?,
                    cached_tokens: read_opt_u64(row, 4)?,
                    output_tokens: read_opt_u64(row, 5)?,
                    sessions: None,
                })
            },
        )?;

        let sessions = query_rows(
            &conn,
            "SELECT day, sessions FROM stats_session_day
             WHERE provider = ?1 AND source = ?2 AND day >= ?3 AND day <= ?4",
            key,
            |row| Ok((row.get::<_, String>(0)?, read_u64(row, 1)?)),
        )?;
        let sessions: BTreeMap<String, u64> = sessions.into_iter().collect();
        for day in &mut days {
            day.sessions = sessions.get(&day.day).copied();
        }

        let model_days = query_rows(
            &conn,
            "SELECT day, model_id, tokens, requests
             FROM stats_model_day
             WHERE provider = ?1 AND source = ?2 AND day >= ?3 AND day <= ?4
             ORDER BY day, model_id",
            key,
            |row| {
                Ok(ModelDayRow {
                    day: row.get(0)?,
                    model_id: row.get(1)?,
                    tokens: read_u64(row, 2)?,
                    requests: read_opt_u64(row, 3)?,
                })
            },
        )?;

        let models = query_rows(
            &conn,
            "SELECT model_id, SUM(tokens), SUM(requests)
             FROM stats_model_day
             WHERE provider = ?1 AND source = ?2 AND day >= ?3 AND day <= ?4
             GROUP BY model_id
             ORDER BY SUM(tokens) DESC, model_id",
            key,
            |row| {
                Ok(ModelTotal {
                    model_id: row.get(0)?,
                    tokens: read_u64(row, 1)?,
                    requests: read_opt_u64(row, 2)?,
                })
            },
        )?;

        let totals = aggregate(&days);
        let coverage = read_coverage(&conn, provider, source)?;

        Ok(RangeReport {
            provider,
            source,
            from: from.to_string(),
            to: to.to_string(),
            totals,
            days,
            model_days,
            models,
            coverage,
        })
    }

    /// What is stored, without reading a range.
    pub fn coverage(&self, provider: ProviderKind, source: StatsSource) -> Result<Coverage, Error> {
        read_coverage(&self.database.lock(), provider, source)
    }
}

fn storage_error(context: &str, error: rusqlite::Error) -> Error {
    Error::storage(format!("{context}: {error}"))
}

fn query_rows<T>(
    conn: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
    map: impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, Error> {
    let mut statement = conn
        .prepare(sql)
        .map_err(|err| storage_error("Could not read usage stats", err))?;
    let rows = statement
        .query_map(params, map)
        .map_err(|err| storage_error("Could not read usage stats", err))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| storage_error("Could not read usage stats", err))?;
    Ok(rows)
}

fn read_u64(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value = row.get::<_, i64>(index)?;
    Ok(u64::try_from(value).unwrap_or(0))
}

fn read_opt_u64(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Option<u64>> {
    Ok(row
        .get::<_, Option<i64>>(index)?
        .map(|value| u64::try_from(value).unwrap_or(0)))
}

fn upsert_day(
    txn: &Connection,
    provider: ProviderKind,
    source: StatsSource,
    day: &DayStat,
) -> Result<(), Error> {
    txn.execute(
        "INSERT INTO stats_day
             (provider, source, day, tokens, requests, prompt_tokens, cached_tokens, output_tokens)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(provider, source, day) DO UPDATE SET
             tokens = excluded.tokens,
             requests = excluded.requests,
             prompt_tokens = excluded.prompt_tokens,
             cached_tokens = excluded.cached_tokens,
             output_tokens = excluded.output_tokens",
        rusqlite::params![
            provider.as_str(),
            source.as_str(),
            day.day,
            day.tokens as i64,
            day.requests.map(|value| value as i64),
            day.prompt_tokens.map(|value| value as i64),
            day.cached_tokens.map(|value| value as i64),
            day.output_tokens.map(|value| value as i64),
        ],
    )
    .map_err(|err| storage_error("Could not store usage stats", err))?;
    Ok(())
}

fn upsert_model_day(
    txn: &Connection,
    provider: ProviderKind,
    source: StatsSource,
    day: &ModelDayStat,
) -> Result<(), Error> {
    txn.execute(
        "INSERT INTO stats_model_day (provider, source, day, model_id, tokens, requests)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(provider, source, day, model_id) DO UPDATE SET
             tokens = excluded.tokens,
             requests = excluded.requests",
        rusqlite::params![
            provider.as_str(),
            source.as_str(),
            day.day,
            day.model_id,
            day.tokens as i64,
            day.requests.map(|value| value as i64),
        ],
    )
    .map_err(|err| storage_error("Could not store usage stats", err))?;
    Ok(())
}

fn upsert_session_day(
    txn: &Connection,
    provider: ProviderKind,
    source: StatsSource,
    day: &SessionDayStat,
) -> Result<(), Error> {
    txn.execute(
        "INSERT INTO stats_session_day (provider, source, day, sessions)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(provider, source, day) DO UPDATE SET sessions = excluded.sessions",
        rusqlite::params![
            provider.as_str(),
            source.as_str(),
            day.day,
            day.sessions as i64,
        ],
    )
    .map_err(|err| storage_error("Could not store usage stats", err))?;
    Ok(())
}

/// Records what this reading learned, and returns the coverage it leaves behind.
///
/// `first_day` and `last_day` are re-read from the rows themselves rather than
/// accumulated from what arrived, so coverage cannot drift away from the data
/// even if a fetch is partial or out of order.
fn record_coverage(txn: &Connection, input: &ReadingInput) -> Result<Coverage, Error> {
    let provider = input.provider.as_str();
    let source = input.source.as_str();
    let (first_day, last_day): (Option<String>, Option<String>) = txn
        .query_row(
            "SELECT MIN(day), MAX(day) FROM stats_day WHERE provider = ?1 AND source = ?2",
            rusqlite::params![provider, source],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|err| storage_error("Could not store usage stats", err))?;

    // One day before the oldest stored day is the next thing worth fetching.
    // Clamped at the retention floor so the cursor can never ask for a day that
    // a prune would immediately delete.
    let floor = retention_floor(input.fetched_at);
    let backfill_cursor = first_day.as_deref().and_then(|day| {
        let parsed = parse_day_ms(day)?;
        let next = clock::utc_day(parsed - 86_400_000);
        (next > floor).then_some(next)
    });

    txn.execute(
        "INSERT INTO stats_coverage
             (provider, source, last_fetched_at, first_day, last_day, backfill_cursor,
              headline_tokens, headline_requests, window_days,
              window_prompt_tokens, window_cached_tokens, window_hit_rate)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(provider, source) DO UPDATE SET
             last_fetched_at = excluded.last_fetched_at,
             first_day = excluded.first_day,
             last_day = excluded.last_day,
             backfill_cursor = excluded.backfill_cursor,
             headline_tokens = COALESCE(excluded.headline_tokens, headline_tokens),
             headline_requests = COALESCE(excluded.headline_requests, headline_requests),
             window_days = COALESCE(excluded.window_days, window_days),
             window_prompt_tokens = COALESCE(excluded.window_prompt_tokens, window_prompt_tokens),
             window_cached_tokens = COALESCE(excluded.window_cached_tokens, window_cached_tokens),
             window_hit_rate = COALESCE(excluded.window_hit_rate, window_hit_rate)",
        rusqlite::params![
            provider,
            source,
            input.fetched_at,
            first_day,
            last_day,
            backfill_cursor,
            input.headline_tokens.map(|value| value as i64),
            input.headline_requests.map(|value| value as i64),
            input.window_days.map(|value| value as i64),
            input.window_prompt_tokens.map(|value| value as i64),
            input.window_cached_tokens.map(|value| value as i64),
            input.window_hit_rate,
        ],
    )
    .map_err(|err| storage_error("Could not store usage stats", err))?;

    Ok(Coverage {
        provider: input.provider,
        source: input.source,
        last_fetched_at: Some(input.fetched_at),
        first_day,
        last_day,
        backfill_cursor,
        headline_tokens: input.headline_tokens,
        headline_requests: input.headline_requests,
        window_days: input.window_days,
        window_prompt_tokens: input.window_prompt_tokens,
        window_cached_tokens: input.window_cached_tokens,
        window_hit_rate: input.window_hit_rate,
    })
}

/// The oldest day still inside the retention window.
fn retention_floor(now_ms: i64) -> String {
    clock::utc_day_offset(now_ms, RETENTION_DAYS)
}

/// Epoch ms for a `YYYY-MM-DD` day, or none when the value is not a day this
/// build accepts.
fn parse_day_ms(day: &str) -> Option<i64> {
    if !clock::is_day_key(day) {
        return None;
    }
    let year: i64 = day[0..4].parse().ok()?;
    let month: i64 = day[5..7].parse().ok()?;
    let date: i64 = day[8..10].parse().ok()?;
    Some(day_from_civil(year, month, date) * 86_400_000)
}

/// Civil-to-days, the inverse of [`clock::utc_day`]'s days-to-civil.
fn day_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Drops every row older than `floor`, for every provider and lens.
///
/// Pruning by day rather than by provider means one statement covers every
/// series, and the retained rows stay a contiguous tail of the primary key.
fn prune(txn: &Connection, floor: &str) -> Result<(), Error> {
    txn.execute("DELETE FROM stats_day WHERE day < ?1", [floor])
        .map_err(|err| storage_error("Could not prune usage stats", err))?;
    txn.execute("DELETE FROM stats_model_day WHERE day < ?1", [floor])
        .map_err(|err| storage_error("Could not prune usage stats", err))?;
    txn.execute("DELETE FROM stats_session_day WHERE day < ?1", [floor])
        .map_err(|err| storage_error("Could not prune usage stats", err))?;
    Ok(())
}

fn read_coverage(
    conn: &Connection,
    provider: ProviderKind,
    source: StatsSource,
) -> Result<Coverage, Error> {
    conn.query_row(
        "SELECT last_fetched_at, first_day, last_day, backfill_cursor,
                headline_tokens, headline_requests, window_days,
                window_prompt_tokens, window_cached_tokens, window_hit_rate
         FROM stats_coverage WHERE provider = ?1 AND source = ?2",
        rusqlite::params![provider.as_str(), source.as_str()],
        |row| {
            Ok(Coverage {
                provider,
                source,
                last_fetched_at: row.get(0)?,
                first_day: row.get(1)?,
                last_day: row.get(2)?,
                backfill_cursor: row.get(3)?,
                headline_tokens: read_opt_u64(row, 4)?,
                headline_requests: read_opt_u64(row, 5)?,
                window_days: read_opt_u64(row, 6)?,
                window_prompt_tokens: read_opt_u64(row, 7)?,
                window_cached_tokens: read_opt_u64(row, 8)?,
                window_hit_rate: row.get(9)?,
            })
        },
    )
    .optional()
    .map_err(|err| storage_error("Could not read usage stats", err))
    .map(|coverage| coverage.unwrap_or_else(|| Coverage::empty(provider, source)))
}

/// Totals for a range, from the rows already fetched.
///
/// The rows are in range by construction, so this sums the range and nothing
/// else. A counter is `Some` only when **every** day in the range reported it:
/// summing a partly-reported column would present unreported days as zero usage,
/// which is the one answer a usage figure must never give. An empty range
/// reports `None` for the same reason — no rows is not the same as no usage.
fn aggregate(days: &[DayRow]) -> RangeTotals {
    if days.is_empty() {
        return RangeTotals::default();
    }
    RangeTotals {
        tokens: days
            .iter()
            .fold(0u64, |sum, day| sum.saturating_add(day.tokens)),
        requests: sum_reported(days.iter().map(|day| day.requests)),
        sessions: sum_reported(days.iter().map(|day| day.sessions)),
        peak_daily_tokens: days.iter().map(|day| day.tokens).max(),
        prompt_tokens: sum_reported(days.iter().map(|day| day.prompt_tokens)),
        cached_tokens: sum_reported(days.iter().map(|day| day.cached_tokens)),
    }
}

/// Sums a column that must be fully reported to mean anything.
fn sum_reported(values: impl Iterator<Item = Option<u64>>) -> Option<u64> {
    values
        .into_iter()
        .reduce(|left, right| match (left, right) {
            (Some(left), Some(right)) => Some(left.saturating_add(right)),
            _ => None,
        })
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lens_a_rust_value_names_is_the_lens_the_database_accepts() {
        for source in [StatsSource::Account, StatsSource::Local] {
            assert_eq!(StatsSource::from_str(source.as_str()), Some(source));
        }
        assert_eq!(StatsSource::from_str("rollouts"), None);

        let store = store();
        let rejected = store.database.lock().execute(
            "INSERT INTO stats_day (provider, source, day, tokens) VALUES ('zai', 'rollouts', '2026-10-12', 1)",
            [],
        );
        assert!(
            rejected.is_err(),
            "the CHECK and the Rust mapping must not disagree about a lens"
        );
    }

    /// 2026-10-13T00:00:00Z: a UTC midnight, so a day offset lands on a day
    /// boundary rather than a time inside one.
    const NOW: i64 = 1_791_849_600_000;

    fn store() -> StatsStore {
        StatsStore::new(Arc::new(
            Database::open_in_memory().expect("an in-memory database"),
        ))
    }

    fn day(day: &str, tokens: u64) -> DayStat {
        DayStat {
            day: day.to_string(),
            tokens,
            ..DayStat::default()
        }
    }

    fn reading(provider: ProviderKind, days: &[(&str, u64)]) -> ReadingInput {
        ReadingInput {
            days: days
                .iter()
                .map(|(name, tokens)| day(name, *tokens))
                .collect(),
            ..ReadingInput::new(provider, StatsSource::Account, NOW)
        }
    }

    fn count(store: &StatsStore, sql: &str) -> i64 {
        store
            .database
            .lock()
            .query_row(sql, [], |row| row.get(0))
            .expect("counts")
    }

    #[test]
    fn a_refresh_corrects_its_day_instead_of_appending_one() {
        let store = store();
        store
            .record(reading(ProviderKind::Zai, &[("2026-10-12", 100)]))
            .expect("stores");
        store
            .record(reading(ProviderKind::Zai, &[("2026-10-12", 250)]))
            .expect("stores again");

        let report = store
            .range(
                ProviderKind::Zai,
                StatsSource::Account,
                "2026-10-01",
                "2026-10-13",
            )
            .expect("reads");
        assert_eq!(
            report.days.len(),
            1,
            "one day is one row however often it is reported"
        );
        assert_eq!(report.days[0].tokens, 250, "the later reading wins");
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM stats_day"),
            1,
            "the table cannot grow with the poll count"
        );
    }

    #[test]
    fn a_year_of_hourly_polling_stores_what_a_year_of_daily_polling_does() {
        let store = store();
        for hour in 0..(365 * 24) {
            store
                .record(ReadingInput {
                    days: vec![day(&clock::utc_day(NOW - hour * 3_600_000), hour as u64)],
                    ..ReadingInput::new(ProviderKind::Zai, StatsSource::Account, NOW)
                })
                .expect("stores");
        }
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM stats_day"),
            366,
            "8760 refreshes collapse onto one row per day, partial current day included"
        );
    }

    #[test]
    fn a_range_returns_only_the_days_it_asks_for() {
        let store = store();
        store
            .record(reading(
                ProviderKind::Zai,
                &[
                    ("2026-10-09", 10),
                    ("2026-10-10", 20),
                    ("2026-10-11", 30),
                    ("2026-10-12", 40),
                ],
            ))
            .expect("stores");

        let report = store
            .range(
                ProviderKind::Zai,
                StatsSource::Account,
                "2026-10-10",
                "2026-10-11",
            )
            .expect("reads");
        let days: Vec<&str> = report.days.iter().map(|day| day.day.as_str()).collect();
        assert_eq!(days, ["2026-10-10", "2026-10-11"]);
        assert_eq!(report.totals.tokens, 50);
        assert_eq!(report.totals.peak_daily_tokens, Some(30));
    }

    #[test]
    fn an_empty_range_reports_no_usage_rather_than_zero() {
        let store = store();
        store
            .record(reading(ProviderKind::Zai, &[("2026-10-12", 40)]))
            .expect("stores");

        let report = store
            .range(
                ProviderKind::Zai,
                StatsSource::Account,
                "2026-01-01",
                "2026-01-31",
            )
            .expect("reads");
        assert!(report.days.is_empty());
        assert_eq!(report.totals.tokens, 0, "nothing stored in range");
        assert_eq!(
            report.totals.requests, None,
            "no rows is not the same as no usage"
        );
        assert_eq!(report.totals.peak_daily_tokens, None);
    }

    #[test]
    fn a_partly_reported_counter_stays_unreported() {
        let store = store();
        let mut input = reading(ProviderKind::Zai, &[("2026-10-11", 20), ("2026-10-12", 30)]);
        input.days[0].requests = Some(7);
        input.days[1].requests = None;
        store.record(input).expect("stores");

        let report = store
            .range(
                ProviderKind::Zai,
                StatsSource::Account,
                "2026-10-11",
                "2026-10-12",
            )
            .expect("reads");
        assert_eq!(report.days[0].requests, Some(7));
        assert_eq!(report.days[1].requests, None);
        assert_eq!(
            report.totals.requests, None,
            "one unreported day must not read as zero calls"
        );
    }

    #[test]
    fn the_two_lenses_are_stored_apart_and_never_summed() {
        let store = store();
        store
            .record(ReadingInput {
                days: vec![day("2026-10-12", 1_000)],
                ..ReadingInput::new(ProviderKind::Codex, StatsSource::Account, NOW)
            })
            .expect("stores the account read");
        store
            .record(ReadingInput {
                days: vec![day("2026-10-12", 1_000)],
                ..ReadingInput::new(ProviderKind::Codex, StatsSource::Local, NOW)
            })
            .expect("stores the local scan");

        assert_eq!(
            count(
                &store,
                "SELECT COUNT(*) FROM stats_day WHERE provider = 'codex'"
            ),
            2,
            "the lens is part of the key, so neither read overwrites the other"
        );
        let account = store
            .range(
                ProviderKind::Codex,
                StatsSource::Account,
                "2026-10-12",
                "2026-10-12",
            )
            .expect("reads");
        assert_eq!(
            account.totals.tokens, 1_000,
            "Codex's two lenses never add to 2,000"
        );
    }

    #[test]
    fn model_totals_are_grouped_by_the_database_inside_the_range() {
        let store = store();
        store
            .record(ReadingInput {
                days: vec![day("2026-10-11", 90), day("2026-10-12", 110)],
                model_days: vec![
                    ModelDayStat {
                        day: "2026-10-11".into(),
                        model_id: "glm-5.3".into(),
                        tokens: 40,
                        requests: None,
                    },
                    ModelDayStat {
                        day: "2026-10-11".into(),
                        model_id: "glm-5.3-flash".into(),
                        tokens: 50,
                        requests: None,
                    },
                    ModelDayStat {
                        day: "2026-10-12".into(),
                        model_id: "glm-5.3".into(),
                        tokens: 110,
                        requests: None,
                    },
                ],
                ..ReadingInput::new(ProviderKind::Zai, StatsSource::Account, NOW)
            })
            .expect("stores");

        let report = store
            .range(
                ProviderKind::Zai,
                StatsSource::Account,
                "2026-10-11",
                "2026-10-12",
            )
            .expect("reads");
        assert_eq!(
            report
                .models
                .iter()
                .map(|model| (model.model_id.as_str(), model.tokens))
                .collect::<Vec<_>>(),
            [("glm-5.3", 150), ("glm-5.3-flash", 50)],
            "SQL groups and ranks, so the renderer never sums a full series"
        );
        assert_eq!(report.model_days.len(), 3);

        let one_day = store
            .range(
                ProviderKind::Zai,
                StatsSource::Account,
                "2026-10-12",
                "2026-10-12",
            )
            .expect("reads");
        assert_eq!(
            one_day.models.len(),
            1,
            "the earlier day's models fall outside the range"
        );
        assert_eq!(one_day.models[0].tokens, 110);
    }

    #[test]
    fn a_session_count_is_stored_where_no_token_count_describes_it() {
        let store = store();
        store
            .record(ReadingInput {
                days: vec![day("2026-10-12", 500)],
                session_days: vec![SessionDayStat {
                    day: "2026-10-12".into(),
                    sessions: 12,
                }],
                ..ReadingInput::new(ProviderKind::Codex, StatsSource::Local, NOW)
            })
            .expect("stores");

        let report = store
            .range(
                ProviderKind::Codex,
                StatsSource::Local,
                "2026-10-12",
                "2026-10-12",
            )
            .expect("reads");
        assert_eq!(report.days[0].sessions, Some(12));
        assert_eq!(report.totals.sessions, Some(12));
    }

    #[test]
    fn coverage_reports_what_is_actually_stored() {
        let store = store();
        store
            .record(reading(
                ProviderKind::Zai,
                &[("2026-10-11", 10), ("2026-10-12", 20)],
            ))
            .expect("stores");

        let coverage = store
            .coverage(ProviderKind::Zai, StatsSource::Account)
            .expect("reads");
        assert_eq!(coverage.first_day.as_deref(), Some("2026-10-11"));
        assert_eq!(coverage.last_day.as_deref(), Some("2026-10-12"));
        assert_eq!(coverage.last_fetched_at, Some(NOW));
    }

    #[test]
    fn coverage_for_a_provider_nothing_is_stored_for_is_empty_not_an_error() {
        let store = store();
        let coverage = store
            .coverage(ProviderKind::Kimi, StatsSource::Local)
            .expect("reads");
        assert_eq!(coverage.last_fetched_at, None);
        assert_eq!(coverage.first_day, None);
    }

    #[test]
    fn the_backfill_cursor_walks_backwards_and_stops_at_the_retention_floor() {
        let store = store();
        store
            .record(reading(ProviderKind::Zai, &[("2026-10-12", 20)]))
            .expect("stores");
        let coverage = store
            .coverage(ProviderKind::Zai, StatsSource::Account)
            .expect("reads");
        assert_eq!(
            coverage.backfill_cursor.as_deref(),
            Some("2026-10-11"),
            "the next chunk starts the day before the oldest stored one"
        );

        // A chunk that reaches the retention floor stops asking for more, rather
        // than pointing at a day a prune would delete on the next write.
        let old = clock::utc_day_offset(NOW, RETENTION_DAYS - 1);
        store
            .record(reading(ProviderKind::Zai, &[(old.as_str(), 5)]))
            .expect("stores");
        let coverage = store
            .coverage(ProviderKind::Zai, StatsSource::Account)
            .expect("reads");
        assert_eq!(coverage.backfill_cursor, None);
    }

    #[test]
    fn a_headline_figure_survives_a_later_read_that_reports_none() {
        let store = store();
        store
            .record(ReadingInput {
                days: vec![day("2026-10-12", 1_000)],
                headline_tokens: Some(2_947_664_271),
                headline_requests: Some(10_419),
                window_days: None,
                ..ReadingInput::new(ProviderKind::Codex, StatsSource::Account, NOW)
            })
            .expect("stores");
        store
            .record(reading(ProviderKind::Codex, &[("2026-10-13", 2_000)]))
            .expect("stores again");

        let coverage = store
            .coverage(ProviderKind::Codex, StatsSource::Account)
            .expect("reads");
        assert_eq!(
            coverage.headline_tokens,
            Some(2_947_664_271),
            "a lifetime total is not cleared by a day that omitted it"
        );
        let report = store
            .range(
                ProviderKind::Codex,
                StatsSource::Account,
                "2026-10-12",
                "2026-10-13",
            )
            .expect("reads");
        assert_eq!(
            report.totals.tokens, 3_000,
            "the range sum is its own figure, never the lifetime one"
        );
    }

    #[test]
    fn a_window_cache_split_is_kept_beside_the_days_not_inside_one() {
        let store = store();
        store
            .record(ReadingInput {
                days: vec![day("2026-10-12", 500)],
                window_prompt_tokens: Some(3_672_219_740),
                window_cached_tokens: Some(3_578_491_328),
                window_hit_rate: Some(0.9747),
                window_days: Some(30),
                ..ReadingInput::new(ProviderKind::Zai, StatsSource::Account, NOW)
            })
            .expect("stores");

        let coverage = store
            .coverage(ProviderKind::Zai, StatsSource::Account)
            .expect("reads");
        assert_eq!(coverage.window_hit_rate, Some(0.9747));
        assert_eq!(coverage.window_days, Some(30));

        let report = store
            .range(
                ProviderKind::Zai,
                StatsSource::Account,
                "2026-10-12",
                "2026-10-12",
            )
            .expect("reads");
        assert_eq!(
            report.totals.prompt_tokens, None,
            "one day without a split does not inherit the window's"
        );
    }

    #[test]
    fn rows_older_than_the_retention_window_are_pruned() {
        let store = store();
        let inside = clock::utc_day_offset(NOW, RETENTION_DAYS - 1);
        let outside = clock::utc_day_offset(NOW, RETENTION_DAYS + 1);
        store
            .record(reading(
                ProviderKind::Zai,
                &[(inside.as_str(), 5), (outside.as_str(), 7)],
            ))
            .expect("stores");

        assert_eq!(count(&store, "SELECT COUNT(*) FROM stats_day"), 1);
        let coverage = store
            .coverage(ProviderKind::Zai, StatsSource::Account)
            .expect("reads");
        assert_eq!(coverage.first_day.as_deref(), Some(inside.as_str()));
    }

    #[test]
    fn pruning_takes_the_model_rows_with_the_days_they_belong_to() {
        let store = store();
        let outside = clock::utc_day_offset(NOW, RETENTION_DAYS + 1);
        store
            .record(ReadingInput {
                days: vec![day(&outside, 7)],
                model_days: vec![ModelDayStat {
                    day: outside.clone(),
                    model_id: "glm-5.3".into(),
                    tokens: 7,
                    requests: None,
                }],
                session_days: vec![SessionDayStat {
                    day: outside.clone(),
                    sessions: 1,
                }],
                ..ReadingInput::new(ProviderKind::Zai, StatsSource::Account, NOW)
            })
            .expect("stores");

        assert_eq!(count(&store, "SELECT COUNT(*) FROM stats_day"), 0);
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM stats_model_day"),
            0,
            "a model row cannot outlive the day it describes"
        );
        assert_eq!(count(&store, "SELECT COUNT(*) FROM stats_session_day"), 0);
    }

    #[test]
    fn the_schema_refuses_a_day_that_is_not_a_day() {
        let store = store();
        let error = store.record(ReadingInput {
            days: vec![day("12/10/2026", 10)],
            ..ReadingInput::new(ProviderKind::Zai, StatsSource::Account, NOW)
        });
        assert!(error.is_err(), "a malformed day key must not be stored");
    }

    #[test]
    fn the_schema_refuses_a_cache_read_larger_than_the_prompt_it_came_from() {
        let store = store();
        let mut stat = day("2026-10-12", 100);
        stat.prompt_tokens = Some(50);
        stat.cached_tokens = Some(51);
        let error = store.record(ReadingInput {
            days: vec![stat],
            ..ReadingInput::new(ProviderKind::Zai, StatsSource::Account, NOW)
        });
        assert!(
            error.is_err(),
            "the contradiction is refused rather than stored and re-read"
        );
    }

    #[test]
    fn the_schema_refuses_negative_tokens() {
        let store = store();
        let error = store.record(ReadingInput {
            days: vec![DayStat {
                day: "2026-10-12".into(),
                tokens: (-1_i64) as u64,
                ..DayStat::default()
            }],
            ..ReadingInput::new(ProviderKind::Zai, StatsSource::Account, NOW)
        });
        assert!(error.is_err());
    }

    #[test]
    fn a_refused_write_leaves_the_stored_days_untouched() {
        let store = store();
        store
            .record(reading(ProviderKind::Zai, &[("2026-10-12", 100)]))
            .expect("stores");
        let _ = store.record(ReadingInput {
            days: vec![day("2026-10-12", 999), day("not-a-day", 1)],
            ..ReadingInput::new(ProviderKind::Zai, StatsSource::Account, NOW)
        });

        let report = store
            .range(
                ProviderKind::Zai,
                StatsSource::Account,
                "2026-10-12",
                "2026-10-12",
            )
            .expect("reads");
        assert_eq!(
            report.days[0].tokens, 100,
            "the whole reading is one transaction, so the good row never landed"
        );
    }

    #[test]
    fn a_day_key_round_trips_through_epoch_millis() {
        for day in [
            "1970-01-01",
            "2026-02-28",
            "2026-03-01",
            "2026-12-31",
            "2100-01-01",
        ] {
            let ms = parse_day_ms(day).expect("parses");
            assert_eq!(clock::utc_day(ms), day, "{day} survives the round trip");
        }
        assert_eq!(parse_day_ms("2026-10-12T00:00:00Z"), None);
        assert_eq!(parse_day_ms(""), None);
    }

    #[test]
    fn two_databases_over_one_file_serialize_instead_of_failing() {
        // The windowed app and the headless background service share this file.
        let dir = std::env::temp_dir().join(format!("agentgauge-stats-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let path = dir.join("agentgauge.db");
        let _ = std::fs::remove_file(&path);

        let first = StatsStore::new(Arc::new(Database::open(&path).expect("opens")));
        let second = StatsStore::new(Arc::new(
            Database::open(&path).expect("opens a second handle"),
        ));
        first
            .record(reading(ProviderKind::Zai, &[("2026-10-12", 10)]))
            .expect("the first writer stores");
        second
            .record(reading(ProviderKind::Zai, &[("2026-10-13", 20)]))
            .expect("the second writer waits its turn rather than failing");

        let report = first
            .range(
                ProviderKind::Zai,
                StatsSource::Account,
                "2026-10-12",
                "2026-10-13",
            )
            .expect("reads");
        assert_eq!(report.days.len(), 2, "both handles wrote the one file");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }
}
