use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::shared::database::Database;
use crate::shared::error::Error;

const KEY: &str = "volumeAccessConsent";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeAccessStatus {
    pub needs_consent: bool,
    pub consented: bool,
}

#[derive(Clone)]
pub struct VolumeAccessStore {
    db: Arc<Database>,
}

impl VolumeAccessStore {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    pub fn check(&self) -> VolumeAccessStatus {
        let removable = data_roots_on_removable_volume();
        VolumeAccessStatus {
            needs_consent: !removable.is_empty(),
            consented: self.read_consent(),
        }
    }

    pub fn grant(&self) -> Result<VolumeAccessStatus, Error> {
        self.save_consent()?;
        Ok(self.check())
    }

    fn read_consent(&self) -> bool {
        self.db
            .read_doc(KEY)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<Consent>(&raw).ok())
            .is_some_and(|c| c.granted)
    }

    fn save_consent(&self) -> Result<(), Error> {
        let consent = Consent { granted: true };
        let encoded = serde_json::to_string(&consent)
            .map_err(|e| Error::storage(format!("consent could not be encoded: {e}")))?;
        self.db.write_doc(KEY, &encoded)
    }
}

#[derive(Serialize, Deserialize)]
struct Consent {
    granted: bool,
}

fn data_roots_on_removable_volume() -> Vec<PathBuf> {
    data_roots()
        .into_iter()
        .filter(|path| is_on_removable_volume(path))
        .collect()
}

fn data_roots() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    let codex_override = std::env::var_os("CODEX_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    let xdg_data = std::env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);

    let mut roots = Vec::new();

    if let Some(path) = codex_override {
        roots.push(path);
    } else if let Some(ref home) = home {
        roots.push(home.join(".codex"));
    }

    if let Some(xdg) = xdg_data {
        roots.push(xdg.join("opencode"));
    } else if let Some(ref home) = home {
        roots.push(home.join(".local").join("share").join("opencode"));
    }

    roots
}

#[cfg(target_os = "macos")]
fn is_on_removable_volume(path: &Path) -> bool {
    if path.starts_with("/Volumes/") {
        return true;
    }
    if let Ok(target) = std::fs::read_link(path) {
        let resolved = if target.is_absolute() {
            target
        } else {
            path.parent().map(|p| p.join(&target)).unwrap_or(target)
        };
        if resolved.starts_with("/Volumes/") {
            return true;
        }
    }
    false
}

#[cfg(not(target_os = "macos"))]
fn is_on_removable_volume(_path: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn store(name: &str) -> VolumeAccessStore {
        let dir = std::env::temp_dir().join(format!("agentgauge-permissions-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("creates dir");
        let db = Database::open(&dir.join("agentgauge.db")).expect("opens");
        VolumeAccessStore::new(Arc::new(db))
    }

    #[test]
    fn a_fresh_store_has_no_consent() {
        let s = store("fresh");
        assert!(!s.read_consent());
    }

    #[test]
    fn granting_persists_consent() {
        let s = store("grant");
        s.grant().expect("grants");
        assert!(s.read_consent());
    }

    #[test]
    fn consent_survives_a_reload() {
        let dir = std::env::temp_dir().join("agentgauge-permissions-reload");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("creates dir");
        let db_path = dir.join("agentgauge.db");

        {
            let db = Database::open(&db_path).expect("opens");
            let s = VolumeAccessStore::new(Arc::new(db));
            s.grant().expect("grants");
        }

        let db = Database::open(&db_path).expect("reopens");
        let s = VolumeAccessStore::new(Arc::new(db));
        assert!(s.read_consent());
    }

    #[test]
    fn a_corrupt_document_falls_back_to_no_consent() {
        let s = store("corrupt");
        s.db.write_doc(KEY, "{ not json").expect("seeds");
        assert!(!s.read_consent());
    }

    #[test]
    fn a_path_under_volumes_is_removable() {
        assert!(is_on_removable_volume(Path::new(
            "/Volumes/external1/.codex"
        )));
    }

    #[test]
    fn a_home_path_is_not_removable() {
        assert!(!is_on_removable_volume(Path::new("/Users/testuser/.codex")));
    }

    #[test]
    fn a_root_path_is_not_removable() {
        assert!(!is_on_removable_volume(Path::new("/tmp/test")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_symlink_to_volumes_is_detected() {
        let dir = std::env::temp_dir().join("agentgauge-permissions-symlink");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("creates dir");
        let link = dir.join("linked");
        let _ = fs::remove_file(&link);
        std::os::unix::fs::symlink("/Volumes/external1/data", &link).expect("creates symlink");
        assert!(is_on_removable_volume(&link));
    }
}
