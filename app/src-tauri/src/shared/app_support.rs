//! The active application-support location and the one-time path migration.

use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub const APP_SUPPORT_RELATIVE_DIR: &str = "Library/Application Support/AgentGauge";
pub const PREVIOUS_APP_SUPPORT_RELATIVE_DIR: &str = "Library/Application Support/AI Sub Stats";

static MIGRATION_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn app_support_dir(home: &OsString) -> PathBuf {
    PathBuf::from(home).join(APP_SUPPORT_RELATIVE_DIR)
}

pub fn previous_app_support_dir(home: &OsString) -> PathBuf {
    PathBuf::from(home).join(PREVIOUS_APP_SUPPORT_RELATIVE_DIR)
}

pub fn migrate_file(previous: &Path, current: &Path) -> io::Result<()> {
    if current.exists() || !previous.is_file() {
        return Ok(());
    }

    let parent = current.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "missing destination directory")
    })?;
    fs::create_dir_all(parent)?;

    let temporary = loop {
        let sequence = MIGRATION_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary =
            current.with_extension(format!("migration-{}-{sequence}.tmp", std::process::id()));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(mut file) => {
                let result = fs::File::open(previous)
                    .and_then(|mut source| std::io::copy(&mut source, &mut file))
                    .and_then(|_| file.sync_all());
                if let Err(error) = result {
                    let _ = fs::remove_file(&temporary);
                    return Err(error);
                }
                break temporary;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    };

    match fs::hard_link(&temporary, current) {
        Ok(()) => {
            let _ = fs::remove_file(temporary);
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let _ = fs::remove_file(temporary);
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(temporary);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch() -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("agentgauge-app-support-{stamp}"))
    }

    #[test]
    fn active_directory_uses_the_product_name() {
        let home = OsString::from("/Users/dev");
        assert_eq!(
            app_support_dir(&home),
            PathBuf::from("/Users/dev/Library/Application Support/AgentGauge")
        );
    }

    #[test]
    fn previous_files_copy_forward_without_being_removed_or_overwritten() {
        let root = scratch();
        let previous = root.join("AI Sub Stats/widget-snapshot.json");
        let current = root.join("AgentGauge/widget-snapshot.json");
        fs::create_dir_all(previous.parent().unwrap()).expect("legacy directory");
        fs::write(&previous, b"legacy snapshot").expect("legacy snapshot");

        migrate_file(&previous, &current).expect("migration");

        assert_eq!(
            fs::read(&current).expect("migrated file"),
            b"legacy snapshot"
        );
        assert_eq!(
            fs::read(&previous).expect("preserved file"),
            b"legacy snapshot"
        );
        fs::write(&current, b"newer data").expect("newer file");
        migrate_file(&previous, &current).expect("existing destination is kept");
        assert_eq!(fs::read(&current).expect("current file"), b"newer data");
    }

    #[test]
    fn concurrent_migrations_publish_only_one_complete_file() {
        let root = scratch();
        let previous = root.join("AI Sub Stats/kickoff-schedule.json");
        let current = root.join("AgentGauge/kickoff-schedule.json");
        fs::create_dir_all(previous.parent().unwrap()).expect("legacy directory");
        fs::write(&previous, b"complete legacy schedule").expect("legacy schedule");

        let workers: Vec<_> = (0..8)
            .map(|_| {
                let previous = previous.clone();
                let current = current.clone();
                std::thread::spawn(move || migrate_file(&previous, &current))
            })
            .collect();
        for worker in workers {
            worker.join().expect("migration thread").expect("migration");
        }

        assert_eq!(
            fs::read(&current).expect("published schedule"),
            b"complete legacy schedule"
        );
        assert_eq!(
            fs::read(&previous).expect("preserved schedule"),
            b"complete legacy schedule"
        );
    }
}
