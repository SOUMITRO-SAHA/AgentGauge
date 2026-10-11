//! The legacy shared-data directory the widget, kickoff worker, and app all
//! read and write through.
//!
//! The path predates the rename (`AI Sub Stats`, not `AgentGauge`) and is a
//! compatibility contract: an installed system widget keeps reading its
//! snapshot from exactly here, so the name is fixed. Three modules compose
//! their file names from this one constant so the directory can never drift
//! between them.

use std::ffi::OsString;
use std::path::PathBuf;

/// The directory, relative to the user's home directory.
pub const LEGACY_RELATIVE_DIR: &str = "Library/Application Support/AI Sub Stats";

/// The absolute legacy directory for a home directory value.
pub fn legacy_dir(home: &OsString) -> PathBuf {
    PathBuf::from(home).join(LEGACY_RELATIVE_DIR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_directory_is_composed_not_repeated() {
        assert_eq!(
            legacy_dir(&OsString::from("/Users/dev")),
            PathBuf::from("/Users/dev/Library/Application Support/AI Sub Stats")
        );
    }
}
