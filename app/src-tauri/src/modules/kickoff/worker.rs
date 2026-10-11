//! The headless kickoff tick.
//!
//! Runs with no app window, no Tauri runtime, and no renderer: the system
//! scheduler starts the binary with the `kickoff-worker` argument once a
//! minute, this reads the shared schedule file, fires every due kickoff, and
//! writes the outcomes back. The provider access is injected by the
//! composition root (`lib.rs`), so this module depends on the shared provider
//! types only and stays testable without spawning anything.
//!
//! A tick with nothing due touches nothing and exits — that is what makes a
//! per-minute cadence affordable.

use crate::shared::domain::ProviderKind;
use crate::shared::error::Error;
use crate::shared::provider::PingOutcome;

use super::{KickoffStore, KICKOFF_PROMPT};

/// Sends one kickoff prompt to one provider with an explicit model.
pub type KickFn<'a> =
    dyn Fn(ProviderKind, &str, Option<&str>, Option<&str>) -> Result<PingOutcome, Error> + 'a;

/// Runs one tick: fires every due kickoff and persists the outcomes.
///
/// Returns how many kickoffs fired. The file is written only when something
/// fired, so the 61-of-60 ticks that do nothing leave the file — and the disk
/// — alone.
pub fn tick(store: &KickoffStore, now_ms: i64, kick: &KickFn) -> Result<usize, Error> {
    let mut schedule = store.load();
    let mut fired = 0;

    for sub in schedule
        .subscriptions
        .iter_mut()
        .filter(|sub| sub.is_due(now_ms))
    {
        fired += 1;
        let model = sub.model_id.as_deref();
        let effort = (!sub.effort_id.is_empty()).then_some(sub.effort_id.as_str());
        match kick(sub.kind, KICKOFF_PROMPT, model, effort) {
            Ok(outcome) if outcome.accepted => sub.record_success(now_ms, &outcome.reply),
            Ok(outcome) => sub.record_failure(
                now_ms,
                outcome
                    .reason
                    .as_deref()
                    .unwrap_or("The kickoff was refused."),
            ),
            Err(error) => sub.record_failure(now_ms, &error.message),
        }
    }

    if fired > 0 {
        store.save(&schedule)?;
    }
    Ok(fired)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::kickoff::{KickoffSubscription, KICK_DELAY_MS, WINDOW_MS};
    use std::cell::RefCell;

    fn store_with(sub: KickoffSubscription, dir: &str) -> KickoffStore {
        let kind = sub.kind;
        let path = std::env::temp_dir()
            .join(format!("agentgauge-worker-{dir}"))
            .join("kickoff-schedule.json");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
        let store = KickoffStore::at(path);
        store.update(kind, |_| sub).expect("seeds the schedule");
        store
    }

    #[test]
    fn a_due_subscription_fires_and_persists_the_outcome() {
        let mut sub = KickoffSubscription::new(ProviderKind::Zai);
        sub.set_enabled(true, 0);
        let store = store_with(sub, "due");

        let seen = RefCell::new(Vec::new());
        let kick = |kind: ProviderKind, prompt: &str, model: Option<&str>, effort: Option<&str>| {
            seen.borrow_mut().push((
                kind,
                prompt.to_string(),
                model.map(String::from),
                effort.map(String::from),
            ));
            Ok(PingOutcome {
                accepted: true,
                reply: "Hello!".into(),
                usage: None,
                reason: None,
            })
        };

        let fired = tick(&store, 10_000, &kick).expect("ticks");
        assert_eq!(fired, 1);
        assert_eq!(
            seen.borrow().clone(),
            vec![(ProviderKind::Zai, "hi".to_string(), None, None,)]
        );

        let saved = store.load();
        let zai = saved
            .subscriptions
            .iter()
            .find(|sub| sub.kind == ProviderKind::Zai)
            .expect("entry");
        assert_eq!(zai.last_accepted, Some(true));
        assert_eq!(zai.next_kick_at, Some(10_000 + WINDOW_MS + KICK_DELAY_MS));
    }

    #[test]
    fn a_failed_kickoff_is_recorded_and_backs_off() {
        let mut sub = KickoffSubscription::new(ProviderKind::Kimi);
        sub.set_enabled(true, 0);
        let store = store_with(sub, "failed");

        let kick =
            |_kind: ProviderKind, _prompt: &str, _model: Option<&str>, _effort: Option<&str>| {
                Err(Error::timeout("The provider did not answer."))
            };

        let fired = tick(&store, 5_000, &kick).expect("ticks");
        assert_eq!(fired, 1);
        let kimi = store
            .load()
            .subscriptions
            .into_iter()
            .find(|sub| sub.kind == ProviderKind::Kimi)
            .expect("entry");
        assert_eq!(kimi.last_accepted, Some(false));
        assert!(kimi.last_detail.unwrap().contains("did not answer"));
    }

    #[test]
    fn a_refused_kickoff_is_a_failure_not_a_success() {
        let mut sub = KickoffSubscription::new(ProviderKind::Minimax);
        sub.set_enabled(true, 0);
        let store = store_with(sub, "refused");

        let kick =
            |_kind: ProviderKind, _prompt: &str, _model: Option<&str>, _effort: Option<&str>| {
                Ok(PingOutcome {
                    accepted: false,
                    reply: String::new(),
                    usage: None,
                    reason: Some("OpenCode holds no readable credential.".into()),
                })
            };

        tick(&store, 1_000, &kick).expect("ticks");
        let minimax = store
            .load()
            .subscriptions
            .into_iter()
            .find(|sub| sub.kind == ProviderKind::Minimax)
            .expect("entry");
        assert_eq!(minimax.last_accepted, Some(false));
        assert!(minimax.last_detail.unwrap().contains("credential"));
    }

    #[test]
    fn a_quiet_tick_writes_nothing_and_fires_nothing() {
        let store = store_with(KickoffSubscription::new(ProviderKind::Codex), "quiet");
        let before = std::fs::metadata(store.path())
            .expect("file exists")
            .modified()
            .expect("mtime");

        let fired = tick(&store, 1_000, &|_k, _p, _m, _e| {
            unreachable!("nothing is due")
        })
        .expect("ticks");
        assert_eq!(fired, 0);
        assert_eq!(
            before,
            std::fs::metadata(store.path())
                .expect("still there")
                .modified()
                .expect("mtime"),
            "a quiet tick must not rewrite the schedule"
        );
    }

    #[test]
    fn a_disabled_subscription_never_fires_even_when_scheduled() {
        let mut sub = KickoffSubscription::new(ProviderKind::Codex);
        sub.set_enabled(true, 0);
        sub.set_enabled(false, 1);
        sub.next_kick_at = Some(0);
        let store = store_with(sub, "disabled");

        let fired = tick(&store, 9_000, &|_k, _p, _m, _e| {
            unreachable!("disabled must not fire")
        })
        .expect("ticks");
        assert_eq!(fired, 0);
    }
}
