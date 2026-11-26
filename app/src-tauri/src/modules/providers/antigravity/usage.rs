//! Antigravity's quota windows, read through the CLI's own `/usage` command.
//!
//! `agy -p /usage --output-format json` runs the internal quota command in
//! headless mode: print mode expands internal slash commands by default (the
//! documented `--disable-slash-commands` flag exists only to suppress that),
//! so no model turn runs and no quota is spent. The reply is a structured
//! envelope — `command.name == "usage"`, `command.data.groups[].buckets[]` —
//! carrying every model family's five-hour and weekly `remaining_fraction`
//! and `reset_time`.
//!
//! The read is bounded like every other subprocess this app spawns: the CLI
//! gets `--print-timeout`, and the runner kills it at its own deadline. A
//! missing CLI, an authentication failure, a timeout, or an unrecognized
//! shape all degrade to the caller's unavailable state rather than to a
//! wrong number.

use std::io::Read;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::shared::domain::{ProviderKind, UsageSnapshot, UsageWindow};
use crate::shared::error::Error;
use crate::shared::executable;

use super::{ANTIGRAVITY_DISPLAY_NAME, ANTIGRAVITY_EXECUTABLE, ANTIGRAVITY_PATH_OVERRIDE};

/// The CLI's own headless time limit, so it self-bounds before we kill it.
const PRINT_TIMEOUT: &str = "30s";
/// The runner's kill deadline, longer than `PRINT_TIMEOUT`.
const RUN_TIMEOUT: Duration = Duration::from_secs(40);
const FIVE_HOUR_MINS: i64 = 300;
const WEEKLY_MINS: i64 = 7 * 24 * 60;

/// One quota bucket of the `/usage` reply.
#[derive(Debug, Deserialize)]
struct UsageBucket {
    #[allow(dead_code)]
    id: String,
    /// `"5h"` or `"weekly"` on current builds; unknown values are kept with
    /// no derived duration rather than dropped.
    window: String,
    remaining_fraction: f64,
    reset_time: Option<String>,
}

/// One model family's quota group.
#[derive(Debug, Deserialize)]
struct UsageGroup {
    name: String,
    buckets: Vec<UsageBucket>,
}

/// The `/usage` envelope's payload.
#[derive(Debug, Deserialize)]
struct UsageData {
    groups: Vec<UsageGroup>,
}

/// The command section of the envelope; its `name` proves the reply is the
/// quota command and not a model turn.
#[derive(Debug, Deserialize)]
struct UsageCommand {
    name: String,
    data: UsageData,
}

/// The whole headless reply.
#[derive(Debug, Deserialize)]
struct UsageEnvelope {
    status: String,
    command: UsageCommand,
}

/// One parsed window, ready to become a [`UsageWindow`].
struct ParsedWindow {
    label: String,
    used_percent: i32,
    duration_mins: Option<i64>,
    resets_at: Option<i64>,
}

/// Reads the quota snapshot by running the CLI's own `/usage` command.
///
/// Every anticipated failure — executable missing, refused run, timeout,
/// unrecognized reply — returns an unavailable snapshot carrying the reason,
/// so the Usage tab renders an explicit state instead of an error.
pub fn read_usage_snapshot(kind: ProviderKind, now_ms: i64) -> Result<UsageSnapshot, Error> {
    let output = match run_usage_query() {
        Ok(output) => output,
        Err(error) => return Ok(unavailable(kind, error.message)),
    };
    let windows = match parse_usage_envelope(&output) {
        Ok(windows) => windows,
        Err(error) => return Ok(unavailable(kind, error.message)),
    };
    Ok(live_snapshot(kind, windows, now_ms))
}

fn unavailable(kind: ProviderKind, reason: String) -> UsageSnapshot {
    UsageSnapshot::unavailable(kind, reason)
}

fn live_snapshot(kind: ProviderKind, windows: Vec<ParsedWindow>, now_ms: i64) -> UsageSnapshot {
    let mut snapshot = UsageSnapshot::unavailable(kind, String::new());
    snapshot.freshness = crate::shared::domain::Freshness::Live;
    snapshot.fetched_at = Some(now_ms);
    snapshot.reason = None;
    snapshot.permission = crate::shared::domain::UsagePermission::Allowed;
    snapshot.windows = windows
        .into_iter()
        .map(|window| {
            UsageWindow::new(
                window.label,
                window.used_percent,
                window.duration_mins,
                window.resets_at,
            )
        })
        .collect();
    snapshot
}

/// Runs `agy -p /usage` and returns its stdout, bounded by the CLI's own
/// `--print-timeout` and this runner's kill deadline.
fn run_usage_query() -> Result<String, Error> {
    let candidate = executable::resolve(ANTIGRAVITY_EXECUTABLE, ANTIGRAVITY_PATH_OVERRIDE)
        .ok_or_else(|| {
            Error::provider_missing(executable::not_found_reason(ANTIGRAVITY_PATH_OVERRIDE))
        })?;
    let mut child = candidate
        .command()
        .args([
            "-p",
            "/usage",
            "--output-format",
            "json",
            "--print-timeout",
            PRINT_TIMEOUT,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            Error::provider_missing(format!(
                "Could not run the {ANTIGRAVITY_DISPLAY_NAME} usage command ({error})."
            ))
        })?;

    let deadline = Instant::now() + RUN_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = read_pipe(child.stdout.take());
                let stderr = read_pipe(child.stderr.take());
                if !status.success() {
                    let detail = first_line(&stderr);
                    let detail = if detail.is_empty() {
                        format!("exited with {status}")
                    } else {
                        format!("exited with {status}: {detail}")
                    };
                    return Err(Error::provider_missing(format!(
                        "The {ANTIGRAVITY_DISPLAY_NAME} usage command {detail}."
                    )));
                }
                return Ok(stdout);
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(Error::provider_missing(format!(
                        "The {ANTIGRAVITY_DISPLAY_NAME} usage command did not finish in time."
                    )));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => {
                return Err(Error::provider_missing(format!(
                    "The {ANTIGRAVITY_DISPLAY_NAME} usage command failed ({error})."
                )));
            }
        }
    }
}

fn read_pipe<R: Read>(pipe: Option<R>) -> String {
    let mut text = String::new();
    if let Some(mut pipe) = pipe {
        let _ = pipe.read_to_string(&mut text);
    }
    text
}

fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .to_owned()
}

/// Parses the `/usage` JSON envelope into windows.
///
/// The command name is checked so a stray model reply can never be read as
/// quota; unknown groups keep their own name, and a repeated label keeps the
/// first value rather than rendering two rows under one key.
fn parse_usage_envelope(raw: &str) -> Result<Vec<ParsedWindow>, Error> {
    let envelope: UsageEnvelope = serde_json::from_str(raw).map_err(|error| {
        Error::provider_missing(format!("Could not read the usage reply ({error})."))
    })?;
    if envelope.status != "SUCCESS" {
        return Err(Error::provider_missing(format!(
            "The usage command reported {}.",
            envelope.status
        )));
    }
    if envelope.command.name != "usage" {
        return Err(Error::provider_missing(format!(
            "The reply was the {:?} command, not usage.",
            envelope.command.name
        )));
    }

    let mut windows = Vec::new();
    let mut labels = std::collections::HashSet::new();
    for group in envelope.command.data.groups {
        let family = family_label(&group.name);
        for bucket in group.buckets {
            let label = format!("{family} {}", bucket.window);
            let used = ((1.0 - bucket.remaining_fraction) * 100.0).round() as i32;
            let resets_at = bucket.reset_time.as_deref().and_then(parse_rfc3339_utc);
            let window = ParsedWindow {
                label: label.clone(),
                used_percent: used,
                duration_mins: duration_mins(&bucket.window),
                resets_at,
            };
            if labels.insert(label) {
                windows.push(window);
            }
        }
    }
    if windows.is_empty() {
        return Err(Error::provider_missing(
            "The usage command reported no quota groups.".to_owned(),
        ));
    }
    Ok(windows)
}

/// The short family label a window row renders. Known groups shorten well;
/// anything else keeps the CLI's own group name.
fn family_label(group: &str) -> &str {
    if group.contains("Gemini") {
        "Gemini"
    } else if group.contains("Claude") || group.contains("GPT") {
        "Claude & GPT"
    } else {
        group
    }
}

fn duration_mins(window: &str) -> Option<i64> {
    match window {
        "5h" => Some(FIVE_HOUR_MINS),
        "weekly" => Some(WEEKLY_MINS),
        _ => None,
    }
}

/// Parses Antigravity's RFC3339 UTC reset time (`2026-11-26T17:55:40Z`) into
/// Unix seconds. The repo carries no date-time dependency, so this is the
/// inverse of `civil_from_days` in `sessions.rs`.
fn parse_rfc3339_utc(timestamp: &str) -> Option<i64> {
    let mut parts = timestamp.split(['-', 'T', ':', 'Z']);
    let year: i64 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;
    let hour: i64 = parts.next()?.parse().ok()?;
    let minute: i64 = parts.next()?.parse().ok()?;
    let second: i64 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// Days since the Unix epoch for a proleptic Gregorian date
/// (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let m = if month > 2 { month - 3 } else { month + 9 } as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let year_of_era = y - era * 400;
    let day_of_year = (153 * m + 2) / 5 + day as i64 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The captured reply for the provider-level spawn test, which points the
/// executable override at a script that prints it.
#[cfg(test)]
pub(crate) fn test_fixture_reply() -> &'static str {
    CAPTURED_REPLY
}

/// A verbatim captured reply from agy 1.5.17 on the reference machine.
#[cfg(test)]
pub(crate) const CAPTURED_REPLY: &str = r#"{"conversation_id":"","status":"SUCCESS","response":"Gemini Models\tWeekly Limit Remaining\t75%\t2026-12-03T07:55:40Z\nClaude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-26T18:32:49Z\n","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},"command":{"name":"usage","data":{"description":"Within each group, models share a weekly limit and a 5-hour limit.","groups":[{"name":"Gemini Models","description":"Models within this group: Gemini 4 Hydrogen, Gemini 3.8 Flash","buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","description":"You have used some of your weekly limit, it will fully refresh in 6 days, 18 hours.","window":"weekly","remaining_fraction":0.749521017074585,"reset_time":"2026-12-03T07:55:40Z"},{"id":"gemini-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":1,"reset_time":"2026-11-26T17:55:40Z"}]},{"name":"Claude and GPT models","description":"Models within this group: Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B","buckets":[{"id":"3p-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":1,"reset_time":"2026-12-03T13:32:49Z"},{"id":"3p-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":1,"reset_time":"2026-11-26T18:32:49Z"}]}]}}}"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_captured_reply_parses_into_four_windows() {
        let windows = parse_usage_envelope(CAPTURED_REPLY).expect("parses");
        assert_eq!(windows.len(), 4);
        assert_eq!(windows[0].label, "Gemini weekly");
        assert_eq!(windows[0].used_percent, 25);
        assert_eq!(windows[0].duration_mins, Some(WEEKLY_MINS));
        assert_eq!(windows[0].resets_at, Some(1_796_284_540));
        assert_eq!(windows[1].label, "Gemini 5h");
        assert_eq!(windows[1].used_percent, 0);
        assert_eq!(windows[1].duration_mins, Some(FIVE_HOUR_MINS));
        assert_eq!(windows[3].label, "Claude & GPT 5h");
    }

    #[test]
    fn a_non_success_status_is_rejected() {
        let reply = r#"{"status":"FAILURE","command":{"name":"usage","data":{"groups":[]}}}"#;
        assert!(parse_usage_envelope(reply).is_err());
    }

    #[test]
    fn a_reply_from_another_command_is_rejected() {
        let reply = r#"{"status":"SUCCESS","command":{"name":"model","data":{"groups":[]}}}"#;
        assert!(parse_usage_envelope(reply).is_err());
    }

    #[test]
    fn garbage_is_rejected() {
        assert!(parse_usage_envelope("not json").is_err());
        assert!(parse_usage_envelope("").is_err());
    }

    #[test]
    fn a_reply_without_groups_is_rejected() {
        let reply = r#"{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[]}}}"#;
        assert!(parse_usage_envelope(reply).is_err());
    }

    #[test]
    fn an_unknown_group_keeps_its_name_and_unknown_windows_keep_no_duration() {
        let reply = r#"{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[{"name":"Mystery Models","buckets":[{"id":"m-day","name":"Daily","window":"day","remaining_fraction":0.5}]}]}}}"#;
        let windows = parse_usage_envelope(reply).expect("parses");
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].label, "Mystery Models day");
        assert_eq!(windows[0].duration_mins, None);
        assert_eq!(windows[0].resets_at, None);
    }

    #[test]
    fn a_repeated_window_label_keeps_the_first_value() {
        let reply = r#"{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"id":"a","window":"5h","remaining_fraction":1.0}]},{"name":"Gemini Models","buckets":[{"id":"b","window":"5h","remaining_fraction":0.0}]}]}}}"#;
        let windows = parse_usage_envelope(reply).expect("parses");
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].used_percent, 0);
    }

    #[test]
    fn rfc3339_utc_times_convert_to_unix_seconds() {
        assert_eq!(parse_rfc3339_utc("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_rfc3339_utc("2026-11-26T17:55:40Z"),
            Some(1_795_715_740)
        );
        assert_eq!(
            parse_rfc3339_utc("2024-02-29T12:00:00Z"),
            Some(1_709_208_000)
        );
        assert_eq!(parse_rfc3339_utc("not a time"), None);
    }

    #[test]
    fn civil_and_days_conversions_are_inverses() {
        for (year, month, day) in [(2024, 2, 29u32), (1970, 1, 1), (2026, 12, 3), (2000, 3, 1)] {
            let days = days_from_civil(year, month, day);
            assert_eq!(
                crate::modules::providers::antigravity::sessions::civil_from_days(days),
                (year, month, day),
            );
        }
    }
}
