//! Codex's own rollout logs: the per-response token ledger the app-server
//! account read never exposes.
//!
//! `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and
//! `~/.codex/archived_sessions/*.jsonl` carry a `token_usage_record` per model
//! response, each joined to its model through `turn_context`. Summing those
//! gives a per-model split with a true input/cache/output/reasoning
//! breakdown — the precision a flat provider total can never have.
//!
//! What this module deliberately does not own: pricing. Token counts are facts
//! read from the user's own logs; turning them into money needs the price
//! list, which lives with the domain types. Two figures here are therefore
//! never invented — a response whose turn never got a `turn_context` counts as
//! an explicit unknown model rather than being attributed to whatever ran
//! before it, and a file that cannot be read is counted as unreadable rather
//! than dropped from the totals it would have carried.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use crate::shared::domain::{price_local_models, LocalDayUsage, LocalModelUsage, LocalUsage};

/// The price-list provider Codex's model slugs are priced against. Codex
/// reports its own slugs, which are the catalog's OpenAI ids.
const CODEX_PRICE_PROVIDER: &str = "openai";

/// The model bucket for responses whose turn never received a `turn_context`.
const UNKNOWN_MODEL: &str = "unknown";

/// How deep the rollout walk descends. Sessions nest `YYYY/MM/DD` under
/// `sessions/`; the cap only exists so a pathological tree cannot spin.
const MAX_WALK_DEPTH: usize = 8;

/// Per-model token totals, summed from per-response usage records.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ModelTokens {
    /// Prompt tokens, cache reads included.
    input: u64,
    /// The part of `input` served from the prompt cache.
    cached_input: u64,
    cache_write: u64,
    /// Completion tokens, reasoning included.
    output: u64,
    /// The part of `output` the model spent reasoning. A subset of `output`,
    /// kept because it is the honest read on how much of a response was
    /// thinking rather than answering.
    reasoning: u64,
    responses: u64,
}

impl ModelTokens {
    fn into_usage(self, model: &str) -> LocalModelUsage {
        LocalModelUsage {
            id: model.to_string(),
            display_name: model.to_string(),
            input: self.input,
            cached_input: self.cached_input,
            cache_write: self.cache_write,
            output: self.output,
            reasoning: self.reasoning,
            responses: self.responses,
            cost_usd: None,
        }
    }
}

#[derive(Debug, serde::Deserialize)]
struct RolloutEnvelope {
    #[serde(default)]
    timestamp: String,
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    payload: serde_json::Value,
}

#[derive(Debug, serde::Deserialize)]
struct TurnContextPayload {
    #[serde(default)]
    turn_id: Option<String>,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
struct ResponseUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    cached_input_tokens: u64,
    #[serde(default)]
    cache_write_input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    reasoning_output_tokens: u64,
}

#[derive(Debug, serde::Deserialize)]
struct TokenUsagePayload {
    #[serde(default)]
    turn_id: Option<String>,
    #[serde(default)]
    usage: Option<ResponseUsage>,
}

/// Accumulates a scan across many rollout files.
#[derive(Debug, Default)]
struct Scanner {
    models: BTreeMap<String, ModelTokens>,
    days: BTreeMap<String, u64>,
    files_scanned: u64,
    files_unreadable: u64,
    files_compressed: u64,
    sessions: u64,
}

impl Scanner {
    fn ingest(&mut self, path: &Path) {
        let Ok(file) = fs::File::open(path) else {
            self.files_unreadable += 1;
            return;
        };
        // Turn ids are thread-scoped, so the join table belongs to one file.
        let mut turn_models: HashMap<String, String> = HashMap::new();
        // Most lines in a rollout are conversation content, not accounting.
        // Checking for the two record kinds first keeps a multi-hundred-
        // megabyte history from paying full JSON parse for every line.
        for line in BufReader::new(file).lines() {
            let Ok(line) = line else {
                self.files_unreadable += 1;
                return;
            };
            if !line.contains("token_usage_record") && !line.contains("turn_context") {
                continue;
            }
            let Ok(envelope) = serde_json::from_str::<RolloutEnvelope>(&line) else {
                continue;
            };
            match envelope.kind.as_str() {
                "turn_context" => {
                    if let Ok(context) =
                        serde_json::from_value::<TurnContextPayload>(envelope.payload)
                    {
                        if let (Some(turn_id), Some(model)) = (context.turn_id, context.model) {
                            turn_models.insert(turn_id, model);
                        }
                    }
                }
                "token_usage_record" => {
                    if let Ok(payload) =
                        serde_json::from_value::<TokenUsagePayload>(envelope.payload)
                    {
                        if let Some(usage) = payload.usage {
                            let model = payload
                                .turn_id
                                .as_ref()
                                .and_then(|turn_id| turn_models.get(turn_id))
                                .cloned()
                                .unwrap_or_else(|| UNKNOWN_MODEL.to_string());
                            self.record_usage(&envelope.timestamp, &model, &usage);
                        }
                    }
                }
                _ => {}
            }
        }
        self.files_scanned += 1;
        self.sessions += 1;
    }

    /// Ranks the models, prices what the price list covers, and reports what
    /// it could not price or read as explicit counters.
    fn finish(self) -> LocalUsage {
        let mut models: Vec<LocalModelUsage> = self
            .models
            .into_iter()
            .map(|(model, tokens)| tokens.into_usage(&model))
            .collect();
        models.sort_by(|left, right| {
            right
                .total_tokens()
                .cmp(&left.total_tokens())
                .then_with(|| left.id.cmp(&right.id))
        });
        let pricing = price_local_models(&mut models, CODEX_PRICE_PROVIDER);

        let days: Vec<LocalDayUsage> = self
            .days
            .into_iter()
            .map(|(day, tokens)| LocalDayUsage { day, tokens })
            .collect();
        LocalUsage {
            models,
            first_day: days.first().map(|day| day.day.clone()),
            last_day: days.last().map(|day| day.day.clone()),
            days,
            cost_usd: pricing.total_cost_usd,
            unpriced_tokens: pricing.unpriced_tokens,
            sessions: self.sessions,
            files_scanned: self.files_scanned,
            files_unreadable: self.files_unreadable,
            files_compressed: self.files_compressed,
        }
    }

    fn record_usage(&mut self, timestamp: &str, model: &str, usage: &ResponseUsage) {
        let tokens = self.models.entry(model.to_string()).or_default();
        tokens.input += usage.input_tokens;
        tokens.cached_input += usage.cached_input_tokens.min(usage.input_tokens);
        tokens.cache_write += usage.cache_write_input_tokens;
        tokens.output += usage.output_tokens;
        tokens.reasoning += usage.reasoning_output_tokens.min(usage.output_tokens);
        tokens.responses += 1;

        let day = day_of(timestamp);
        *self.days.entry(day).or_insert(0) += usage.input_tokens + usage.output_tokens;
    }
}

/// The calendar day of a record timestamp, or the empty day when the record
/// carried no usable timestamp.
///
/// The stored key is the UTC date prefix, so days sort and compare as plain
/// strings without pulling in a date library for arithmetic the scan never
/// does.
fn day_of(timestamp: &str) -> String {
    let day = &timestamp[..timestamp.len().min(10)];
    if day.len() == 10 && day.as_bytes()[4] == b'-' && day.as_bytes()[7] == b'-' {
        day.to_string()
    } else {
        String::new()
    }
}

/// Reads the Codex home's rollout logs into the domain's local-usage shape.
///
/// Returns `None` — not an empty reading — when there is no Codex home or it
/// holds no rollouts, so the UI can say the local record is absent rather than
/// showing a confident row of zeroes.
pub fn read_local_usage() -> Option<LocalUsage> {
    local_usage_from(codex_home())
}

/// The Codex home this build should read, from the environment the CLI itself
/// honours. Read once here so the rule stays testable.
fn codex_home() -> Option<PathBuf> {
    codex_home_from(
        std::env::var_os("CODEX_HOME").map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
    )
}

fn codex_home_from(override_home: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
    override_home
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| home.map(|path| path.join(".codex")))
}

/// The scan for an already-resolved home. Pure enough to test against a
/// fixture tree; the filesystem is the only thing it touches.
fn local_usage_from(codex_home: Option<PathBuf>) -> Option<LocalUsage> {
    let usage = scan_codex_home(&codex_home?);
    (!usage.models.is_empty()).then_some(usage)
}

/// Walks the Codex home's rollout directories and sums their token ledgers.
pub fn scan_codex_home(codex_home: &Path) -> LocalUsage {
    let mut scanner = Scanner::default();
    for directory in ["sessions", "archived_sessions"] {
        collect_rollouts(&codex_home.join(directory), 0, &mut scanner);
    }
    scanner.finish()
}

fn collect_rollouts(directory: &Path, depth: usize, scanner: &mut Scanner) {
    if depth > MAX_WALK_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_rollouts(&path, depth + 1, scanner);
        } else if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
            if name.ends_with(".jsonl") {
                scanner.ingest(&path);
            } else if name.ends_with(".jsonl.gz") || name.ends_with(".jsonl.zst") {
                scanner.files_compressed += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[test]
    fn codex_home_prefers_the_explicit_override() {
        assert_eq!(
            codex_home_from(
                Some(PathBuf::from("/opt/codex")),
                Some(PathBuf::from("/home/me"))
            ),
            Some(PathBuf::from("/opt/codex"))
        );
    }

    #[test]
    fn codex_home_falls_back_to_the_dot_directory() {
        assert_eq!(
            codex_home_from(None, Some(PathBuf::from("/home/me"))),
            Some(PathBuf::from("/home/me").join(".codex"))
        );
    }

    #[test]
    fn an_empty_or_absent_override_is_not_a_home() {
        assert_eq!(codex_home_from(None, None), None);
        assert_eq!(
            codex_home_from(Some(PathBuf::new()), Some(PathBuf::from("/home/me"))),
            Some(PathBuf::from("/home/me").join(".codex"))
        );
    }

    #[test]
    fn a_home_with_no_rollouts_reports_nothing_rather_than_zero_usage() {
        let tree = TempTree::new("empty-home");
        tree.make_directory("sessions");
        tree.make_directory("archived_sessions");

        assert_eq!(local_usage_from(Some(tree.0.clone())), None);
    }

    #[test]
    fn no_home_at_all_reports_nothing() {
        assert_eq!(local_usage_from(None), None);
    }

    #[test]
    fn a_scanned_home_reports_its_coverage_and_priced_models() {
        let tree = TempTree::new("priced-home");
        tree.write(
            "sessions/2026/10/01/rollout-a.jsonl",
            &[
                turn_context("2026-10-01T10:00:00.000Z", "t1", "gpt-6-luna"),
                usage_record(
                    "2026-10-01T10:00:01.000Z",
                    "t1",
                    100_000,
                    90_000,
                    10_000,
                    4_000,
                ),
                String::new(),
            ]
            .join("\n"),
        );

        let usage = local_usage_from(Some(tree.0.clone())).expect("a local reading");

        assert_eq!(usage.sessions, 1);
        assert_eq!(usage.models.len(), 1);
        assert_eq!(usage.models[0].id, "gpt-6-luna");
        assert_eq!(usage.models[0].display_name, "GPT-6 Luna");
        // 10k fresh × $0.10/M + 90k cached × $0.01/M + 10k output × $0.50/M
        // = 6,900 / 1M = $0.0069 exactly.
        let cost = usage.models[0].cost_usd.expect("priced");
        assert!((cost - 0.0069).abs() < 0.000_000_1, "cost was {cost}");
        assert!((usage.cost_usd - 0.0069).abs() < 0.000_000_1);
        assert_eq!(usage.unpriced_tokens, 0);
        assert_eq!(usage.models[0].cached_input, 90_000);
    }

    #[test]
    fn a_response_with_no_model_stays_visible_as_an_unpriced_bucket() {
        let tree = TempTree::new("unknown-bucket");
        tree.write(
            "sessions/2026/10/01/rollout-a.jsonl",
            &[
                usage_record("2026-10-01T10:00:00.000Z", "orphan", 5_000, 0, 500, 0),
                String::new(),
            ]
            .join("\n"),
        );

        let usage = local_usage_from(Some(tree.0.clone())).expect("a local reading");

        assert_eq!(usage.models.len(), 1);
        assert_eq!(usage.models[0].id, UNKNOWN_MODEL);
        assert_eq!(usage.models[0].cost_usd, None);
        assert_eq!(usage.unpriced_tokens, 5_500);
        assert_eq!(usage.cost_usd, 0.0);
    }

    /// A throwaway tree for the walk tests, removed on drop.
    struct TempTree(PathBuf);

    impl TempTree {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let mut path = std::env::temp_dir();
            path.push(format!(
                "agentgauge-rollouts-{}-{}-{}",
                std::process::id(),
                tag,
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("temp tree");
            Self(path)
        }

        fn write(&self, relative: &str, contents: &str) {
            let path = self.0.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("parent");
            }
            fs::write(path, contents).expect("write");
        }

        fn make_directory(&self, relative: &str) {
            fs::create_dir_all(self.0.join(relative)).expect("directory");
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn record(timestamp: &str, kind: &str, payload: serde_json::Value) -> String {
        serde_json::json!({ "timestamp": timestamp, "type": kind, "payload": payload }).to_string()
    }

    fn usage_record(
        timestamp: &str,
        turn_id: &str,
        input: u64,
        cached: u64,
        output: u64,
        reasoning: u64,
    ) -> String {
        record(
            timestamp,
            "token_usage_record",
            serde_json::json!({
                "turn_id": turn_id,
                "response_id": "resp_1",
                "usage": {
                    "input_tokens": input,
                    "cached_input_tokens": cached,
                    "cache_write_input_tokens": 0,
                    "output_tokens": output,
                    "reasoning_output_tokens": reasoning,
                    "total_tokens": input + output
                },
                "turn_token_usage": { "input_tokens": 999_999, "output_tokens": 999_999 },
                "thread_token_usage": { "input_tokens": 42_000_000, "output_tokens": 42_000_000 }
            }),
        )
    }

    fn turn_context(timestamp: &str, turn_id: &str, model: &str) -> String {
        record(
            timestamp,
            "turn_context",
            serde_json::json!({
                "turn_id": turn_id,
                "cwd": "/tmp/project",
                "model": model,
                "effort": "high"
            }),
        )
    }

    #[test]
    fn per_response_usage_is_attributed_to_its_turn_model() {
        let tree = TempTree::new("attribution");
        tree.write(
            "sessions/2026/10/01/rollout-a.jsonl",
            &[
                turn_context("2026-10-01T10:00:00.000Z", "t1", "gpt-5.6-terra"),
                usage_record("2026-10-01T10:00:01.000Z", "t1", 1000, 400, 200, 120),
                usage_record("2026-10-01T10:00:02.000Z", "t1", 1200, 500, 300, 30),
                turn_context("2026-10-01T11:00:00.000Z", "t2", "gpt-6-luna"),
                usage_record("2026-10-01T11:00:01.000Z", "t2", 500, 0, 100, 0),
                String::new(),
            ]
            .join("\n"),
        );

        let scan = scan_codex_home(&tree.0);

        assert_eq!(scan.files_scanned, 1);
        assert_eq!(scan.sessions, 1);
        assert_eq!(scan.models.len(), 2);
        let terra = &scan.models[0];
        assert_eq!(terra.id, "gpt-5.6-terra");
        assert_eq!(terra.input, 2200);
        assert_eq!(terra.cached_input, 900);
        assert_eq!(terra.output, 500);
        assert_eq!(terra.reasoning, 150);
        assert_eq!(terra.responses, 2);
        assert_eq!(terra.fresh_input(), 1300);
        assert_eq!(terra.total_tokens(), 2700);
        let luna = &scan.models[1];
        assert_eq!(luna.id, "gpt-6-luna");
        assert_eq!(luna.total_tokens(), 600);
        assert_eq!(
            scan.models[0].total_tokens() + scan.models[1].total_tokens(),
            3300
        );
    }

    #[test]
    fn a_response_whose_turn_never_arrived_stays_unknown() {
        let tree = TempTree::new("unknown-model");
        tree.write(
            "sessions/2026/10/01/rollout-a.jsonl",
            &[
                usage_record("2026-10-01T10:00:00.000Z", "orphan", 900, 0, 100, 0),
                turn_context("2026-10-01T10:00:01.000Z", "t1", "gpt-6-luna"),
                usage_record("2026-10-01T10:00:02.000Z", "t1", 100, 0, 10, 0),
                String::new(),
            ]
            .join("\n"),
        );

        let scan = scan_codex_home(&tree.0);

        let unknown = scan
            .models
            .iter()
            .find(|model| model.id == UNKNOWN_MODEL)
            .expect("an explicit unknown row");
        assert_eq!(unknown.total_tokens(), 1000);
        assert_eq!(unknown.responses, 1);
        let luna = scan
            .models
            .iter()
            .find(|model| model.id == "gpt-6-luna")
            .expect("luna");
        assert_eq!(luna.total_tokens(), 110);
    }

    #[test]
    fn a_compaction_reset_never_inflates_the_totals() {
        let tree = TempTree::new("compaction");
        let mut lines = vec![
            turn_context("2026-10-01T10:00:00.000Z", "t1", "gpt-5.6-terra"),
            usage_record("2026-10-01T10:00:01.000Z", "t1", 100, 0, 10, 0),
            record(
                "2026-10-01T10:05:00.000Z",
                "compacted",
                serde_json::json!({ "message": "compacted" }),
            ),
        ];
        for _ in 0..3 {
            lines.push(usage_record(
                "2026-10-01T10:06:00.000Z",
                "t1",
                100,
                0,
                10,
                0,
            ));
        }
        lines.push(String::new());
        tree.write("sessions/2026/10/01/rollout-a.jsonl", &lines.join("\n"));

        let scan = scan_codex_home(&tree.0);

        assert_eq!(scan.models.len(), 1);
        assert_eq!(scan.models[0].input, 400);
        assert_eq!(scan.models[0].output, 40);
        assert_eq!(scan.models[0].responses, 4);
    }

    #[test]
    fn an_older_record_without_cache_write_still_decodes() {
        let tree = TempTree::new("legacy-shape");
        tree.write(
            "sessions/2026/10/01/rollout-a.jsonl",
            &[
                turn_context("2026-10-01T10:00:00.000Z", "t1", "gpt-5.5"),
                record(
                    "2026-10-01T10:00:01.000Z",
                    "token_usage_record",
                    serde_json::json!({
                        "turn_id": "t1",
                        "usage": {
                            "input_tokens": 700,
                            "cached_input_tokens": 300,
                            "output_tokens": 50,
                            "total_tokens": 750
                        }
                    }),
                ),
                String::new(),
            ]
            .join("\n"),
        );

        let scan = scan_codex_home(&tree.0);

        assert_eq!(scan.models[0].cache_write, 0);
        assert_eq!(scan.models[0].input, 700);
        assert_eq!(scan.models[0].output, 50);
    }

    #[test]
    fn unknown_record_types_and_corrupt_lines_are_skipped() {
        let tree = TempTree::new("noise");
        tree.write(
            "sessions/2026/10/01/rollout-a.jsonl",
            &[
                record(
                    "2026-10-01T10:00:00.000Z",
                    "world_state",
                    serde_json::json!({ "anything": [1, 2, 3] }),
                ),
                String::from("{\"type\":\"token_usage_record\",\"payload\":"),
                record(
                    "2026-10-01T10:00:00.500Z",
                    "response_item",
                    serde_json::json!({ "payload": { "type": "message" } }),
                ),
                turn_context("2026-10-01T10:00:01.000Z", "t1", "gpt-6-luna"),
                usage_record("2026-10-01T10:00:02.000Z", "t1", 200, 100, 20, 5),
                String::new(),
            ]
            .join("\n"),
        );

        let scan = scan_codex_home(&tree.0);

        assert_eq!(scan.files_scanned, 1);
        assert_eq!(scan.files_unreadable, 0);
        assert_eq!(scan.models.len(), 1);
        assert_eq!(scan.models[0].total_tokens(), 220);
    }

    #[test]
    fn days_and_the_coverage_span_come_from_the_record_timestamps() {
        let tree = TempTree::new("days");
        tree.write(
            "sessions/2026/10/01/rollout-a.jsonl",
            &[
                turn_context("2026-10-01T23:59:00.000Z", "t1", "gpt-6-luna"),
                usage_record("2026-10-01T23:59:30.000Z", "t1", 100, 0, 10, 0),
                usage_record("2026-10-03T00:10:00.000Z", "t1", 300, 0, 30, 0),
                String::new(),
            ]
            .join("\n"),
        );
        tree.write(
            "archived_sessions/rollout-b.jsonl",
            &[
                turn_context("2026-09-28T08:00:00.000Z", "t9", "gpt-5.5"),
                usage_record("2026-09-28T08:00:10.000Z", "t9", 50, 0, 5, 0),
                String::new(),
            ]
            .join("\n"),
        );

        let scan = scan_codex_home(&tree.0);

        assert_eq!(scan.files_scanned, 2);
        assert_eq!(scan.sessions, 2);
        assert_eq!(
            scan.days,
            vec![
                LocalDayUsage {
                    day: "2026-09-28".into(),
                    tokens: 55
                },
                LocalDayUsage {
                    day: "2026-10-01".into(),
                    tokens: 110
                },
                LocalDayUsage {
                    day: "2026-10-03".into(),
                    tokens: 330
                },
            ]
        );
        assert_eq!(scan.first_day.as_deref(), Some("2026-09-28"));
        assert_eq!(scan.last_day.as_deref(), Some("2026-10-03"));
    }

    #[test]
    fn a_compressed_rollout_is_counted_as_skipped_not_silently_dropped() {
        let tree = TempTree::new("compressed");
        tree.write(
            "sessions/2026/10/01/rollout-a.jsonl.gz",
            "not really gzip bytes",
        );

        let scan = scan_codex_home(&tree.0);

        assert_eq!(scan.files_compressed, 1);
        assert_eq!(scan.files_scanned, 0);
        assert!((scan.models.is_empty() && scan.days.is_empty()));
    }

    #[test]
    #[cfg(unix)]
    fn a_rollout_that_cannot_be_opened_is_counted_as_unreadable() {
        let tree = TempTree::new("unreadable");
        tree.make_directory("sessions/2026/10/01");
        // A rollout whose file vanished under us (a hand-cleaned history, a
        // stale index) must show as unreadable, not as zero usage.
        std::os::unix::fs::symlink(
            tree.0.join("sessions/2026/10/01/gone.jsonl"),
            tree.0.join("sessions/2026/10/01/rollout-a.jsonl"),
        )
        .expect("dangling rollout link");

        let scan = scan_codex_home(&tree.0);

        assert_eq!(scan.files_unreadable, 1);
        assert_eq!(scan.files_scanned, 0);
    }

    #[test]
    fn an_absent_codex_home_scans_to_nothing() {
        let tree = TempTree::new("absent");
        let missing = tree.0.join("not-installed");

        let scan = scan_codex_home(&missing);

        assert!((scan.models.is_empty() && scan.days.is_empty()));
        assert_eq!(scan.files_scanned, 0);
        assert_eq!(scan.files_unreadable, 0);
        assert_eq!(scan.files_compressed, 0);
    }
}
