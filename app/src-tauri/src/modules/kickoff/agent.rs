//! The macOS launchd agent that wakes the kickoff worker every minute.
//!
//! The requirement is that the kickoff runs whether or not the desktop app is
//! open, so the timer cannot live in the app. `launchd` owns boot survival and
//! wake-from-sleep, and a one-minute `StartInterval` matches the kickoff's
//! "+1 minute" precision: the worker exits within milliseconds on a tick with
//! nothing due, so the cost of the cadence is one process spawn a minute.
//!
//! Everything here is macOS-only by construction; on any other platform the
//! install path reports unsupported rather than pretending to schedule.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::KickoffSchedule;
use crate::shared::error::{Error, ErrorKind};

/// The launchd label, namespaced under the app's identifier.
pub const AGENT_LABEL: &str = "com.soumitrasaha.agentgauge.kickoff";

/// How often launchd wakes the worker.
const START_INTERVAL_SECS: u64 = 60;

/// The plist's path, relative to `$HOME`.
const AGENT_RELATIVE_PATH: &str = "Library/LaunchAgents/com.soumitrasaha.agentgauge.kickoff.plist";

fn agent_relative_path() -> &'static str {
    AGENT_RELATIVE_PATH
}

/// The plist content for a given executable path. Pure, so the schedule
/// contract with launchd is testable without touching launchd.
pub fn plist_xml(executable: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{executable}</string>
        <string>kickoff-worker</string>
    </array>
    <key>StartInterval</key>
    <integer>{START_INTERVAL_SECS}</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
"#
    )
}

/// Whether the agent is installed — the plist launchd was pointed at exists.
///
/// This is a fact about the file, not a query into launchd's state: there is
/// no cheap, stable API for asking launchd, and the file is what this app
/// owns either way.
pub fn is_installed() -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    home_dir()
        .map(|home| home.join(agent_relative_path()).is_file())
        .unwrap_or(false)
}

/// Installs the agent for the current executable.
///
/// The plist points at *this* binary with the `kickoff-worker` argument, so
/// there is no second artifact to build, bundle, or keep in sync. When every
/// subscription is off, the agent is removed instead: an opted-out user must
/// not keep a per-minute timer.
pub fn install(executable: &Path, schedule: &KickoffSchedule) -> Result<(), Error> {
    if !schedule.any_enabled() {
        return uninstall();
    }
    if !cfg!(target_os = "macos") {
        return Err(Error::new(
            ErrorKind::InvalidRequest,
            "The background kickoff scheduler is not supported on this platform yet.",
        ));
    }
    let Some(home) = home_dir() else {
        return Err(Error::storage(
            "No home directory was found, so the scheduler cannot be installed.",
        ));
    };
    install_with(
        &executable.to_string_lossy(),
        &home,
        schedule,
        &mut |program, args| run_command(program, args),
    )
}

/// Removes the agent. Missing is fine — removing an absent agent is done.
pub fn uninstall() -> Result<(), Error> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let Some(home) = home_dir() else {
        return Ok(());
    };
    uninstall_with(&home, &mut |program, args| run_command(program, args))
}

fn install_with(
    executable: &str,
    home: &Path,
    schedule: &KickoffSchedule,
    run: &mut impl FnMut(&str, &[&str]) -> Result<(), Error>,
) -> Result<(), Error> {
    // The policy lives at this seam too: with nothing opted in the agent is
    // removed rather than installed, so an opted-out user never keeps a
    // per-minute timer.
    if !schedule.any_enabled() {
        return uninstall_with(home, run);
    }

    let plist = home.join(agent_relative_path());
    if let Some(parent) = plist.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            Error::storage(format!(
                "Could not create the LaunchAgents directory: {err}"
            ))
        })?;
    }
    fs::write(&plist, plist_xml(executable))
        .map_err(|err| Error::storage(format!("Could not write the scheduler plist: {err}")))?;

    // `bootstrap` is the modern interface; `load` remains as the fallback for
    // the releases where the per-session domain spelled differently.
    let uid = current_uid();
    let bootstrapped = run(
        "launchctl",
        &["bootstrap", &format!("gui/{uid}"), &plist.to_string_lossy()],
    );
    if bootstrapped.is_err() {
        run("launchctl", &["load", &plist.to_string_lossy()])?;
    }
    Ok(())
}

fn uninstall_with(
    home: &Path,
    run: &mut impl FnMut(&str, &[&str]) -> Result<(), Error>,
) -> Result<(), Error> {
    let plist = home.join(agent_relative_path());
    if !plist.exists() {
        return Ok(());
    }

    let uid = current_uid();
    // Not-found is the happy path on an already-removed agent, so the bootout
    // outcome is deliberately ignored; the file is the source of truth.
    let _ = run(
        "launchctl",
        &["bootout", &format!("gui/{uid}"), AGENT_LABEL],
    );
    let _ = run("launchctl", &["unload", &plist.to_string_lossy()]);

    fs::remove_file(&plist)
        .map_err(|err| Error::storage(format!("Could not remove the scheduler plist: {err}")))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn current_uid() -> String {
    Command::new("id")
        .arg("-u")
        .stdin(Stdio::null())
        .output()
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|uid| !uid.is_empty())
        .unwrap_or_else(|| "current".to_string())
}

fn run_command(program: &str, args: &[&str]) -> Result<(), Error> {
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|err| {
            Error::new(
                ErrorKind::ProviderMissing,
                format!("`{program}` could not be run ({err})."),
            )
        })?;
    if output.status.success() {
        return Ok(());
    }
    Err(Error::new(
        ErrorKind::ProviderError,
        format!(
            "`{program} {}` failed ({}).",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::kickoff::{KickoffSubscription, SCHEDULE_RELATIVE_PATH};
    use crate::shared::domain::ProviderKind;

    #[test]
    fn the_plist_names_the_worker_subcommand_at_a_one_minute_cadence() {
        let plist = plist_xml("/Applications/AgentGauge.app/Contents/MacOS/agentgauge");
        assert!(plist.contains("<string>kickoff-worker</string>"));
        assert!(plist.contains("<integer>60</integer>"));
        assert!(plist.contains(AGENT_LABEL));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.contains("<string>Background</string>"));
        assert!(
            !plist.contains("KeepAlive"),
            "the agent must not be kept resident"
        );
    }

    #[test]
    fn installing_writes_the_plist_into_launch_agents_and_bootstraps() {
        let home = std::env::temp_dir().join("agentgauge-agent-install");
        let _ = fs::remove_dir_all(&home);
        let executable = "/Applications/AgentGauge.app/Contents/MacOS/agentgauge";
        let mut bootstrap_calls = 0;
        let mut schedule = KickoffSchedule::default_with_all_kinds();
        schedule.subscriptions[0].enabled = true;

        install_with(executable, &home, &schedule, &mut |program, args| {
            if program == "launchctl" && args.first().is_some_and(|a| *a == "bootstrap") {
                bootstrap_calls += 1;
            }
            Ok(())
        })
        .expect("installs");

        let plist = home.join(agent_relative_path());
        let raw = fs::read_to_string(&plist).expect("plist written");
        assert!(raw.contains("<string>kickoff-worker</string>"));
        assert_eq!(
            bootstrap_calls, 1,
            "a successful bootstrap must not fall through to `load`"
        );
    }

    #[test]
    fn installing_with_everything_off_removes_the_agent_instead() {
        let home = std::env::temp_dir().join("agentgauge-agent-off");
        let _ = fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("Library/LaunchAgents")).expect("dir");
        let plist = home.join(agent_relative_path());
        fs::write(&plist, "seed").expect("seed");

        let schedule = KickoffSchedule::default_with_all_kinds();
        assert!(!schedule.any_enabled());

        install_with("/x/agentgauge", &home, &schedule, &mut |_p, _a| Ok(()))
            .expect("install with nothing on uninstalls");
        assert!(!plist.exists(), "an opted-out user must not keep a timer");
    }

    #[test]
    fn uninstalling_removes_the_plist_and_tells_launchd() {
        let home = std::env::temp_dir().join("agentgauge-agent-uninstall");
        let _ = fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("Library/LaunchAgents")).expect("dir");
        let plist = home.join(agent_relative_path());
        fs::write(&plist, "seed").expect("seed");

        let mut programs: Vec<String> = Vec::new();
        uninstall_with(&home, &mut |program, _args| {
            programs.push(program.to_string());
            Ok(())
        })
        .expect("uninstalls");

        assert!(!plist.exists());
        assert!(programs.contains(&"launchctl".to_string()));
    }

    #[test]
    fn uninstalling_an_absent_agent_succeeds() {
        let home = std::env::temp_dir().join("agentgauge-agent-absent");
        let _ = fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("dir");
        uninstall_with(&home, &mut |_p, _a| Ok(())).expect("absent is fine");
    }

    #[test]
    fn a_schedule_with_one_enabled_sub_is_not_opted_out() {
        let mut schedule = KickoffSchedule::default_with_all_kinds();
        schedule.subscriptions[0] = {
            let mut sub = KickoffSubscription::new(ProviderKind::Codex);
            sub.enabled = true;
            sub
        };
        assert!(schedule.any_enabled());
    }

    #[test]
    fn the_shared_schedule_path_matches_the_widget_directory() {
        // Both files live beside each other by contract.
        assert!(SCHEDULE_RELATIVE_PATH.starts_with("Library/Application Support/AI Sub Stats/"));
    }

    #[test]
    fn the_plist_path_carries_the_label() {
        assert!(AGENT_RELATIVE_PATH.contains(AGENT_LABEL));
    }
}
