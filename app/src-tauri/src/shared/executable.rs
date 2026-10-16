use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// An executable resolved independently of the GUI process's incomplete PATH.
#[derive(Clone, Debug)]
pub struct ResolvedExecutable {
    path: PathBuf,
    search_path: OsString,
}

impl ResolvedExecutable {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn command(&self) -> Command {
        #[cfg(windows)]
        if self.path.extension().is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        }) {
            let command_processor =
                env::var_os("COMSPEC").unwrap_or_else(|| OsString::from("cmd.exe"));
            let mut command = Command::new(command_processor);
            command
                .arg("/D")
                .arg("/C")
                .arg(format!("\"{}\"", self.path.display()))
                .env("PATH", &self.search_path);
            return command;
        }

        let mut command = Command::new(&self.path);
        command.env("PATH", &self.search_path);
        command
    }
}

/// Finds an executable using the inherited PATH, user install conventions, and platform paths.
pub fn candidates(executable: &str, override_variable: &str) -> Vec<ResolvedExecutable> {
    let mut directories = current_search_directories();
    let override_path = env::var_os(override_variable)
        .as_deref()
        .and_then(|value| expand_home(value, home_directory().as_deref()));
    let paths = candidate_paths(executable, override_path.as_deref(), &directories);
    let mut resolved = Vec::with_capacity(paths.len());

    for path in paths {
        if let Some(parent) = path.parent() {
            push_directory(&mut directories, parent.to_path_buf());
        }
        let search_path = env::join_paths(&directories).unwrap_or_default();
        resolved.push(ResolvedExecutable { path, search_path });
    }

    resolved
}

/// Resolves the first executable candidate in the same order used by detection.
pub fn resolve(executable: &str, override_variable: &str) -> Option<ResolvedExecutable> {
    candidates(executable, override_variable).into_iter().next()
}

pub fn not_found_reason(override_variable: &str) -> String {
    format!(
        "Executable was not found in the app PATH or common install locations. Set {override_variable} to its absolute path."
    )
}

fn current_search_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    append_path_value(env::var_os("PATH"), &mut directories);
    #[cfg(target_os = "macos")]
    append_path_value(launchd_path(), &mut directories);

    if let Some(home) = home_directory() {
        directories.extend(user_search_directories(&home));
        append_configured_directories(&home, &mut directories);
        append_codex_directories(&home, &mut directories);
    }

    append_platform_directories(&mut directories);
    deduplicate(&mut directories);
    directories
}

fn home_directory() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

fn append_path_value(value: Option<OsString>, directories: &mut Vec<PathBuf>) {
    if let Some(value) = value {
        for directory in env::split_paths(&value) {
            push_directory(directories, directory);
        }
    }
}

fn user_search_directories(home: &Path) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    for relative in [
        ".local/bin",
        ".opencode/bin",
        "bin",
        ".cargo/bin",
        ".bun/bin",
        ".volta/bin",
        ".asdf/shims",
        ".nodenv/shims",
        ".local/share/mise/shims",
        ".local/share/pnpm",
        "Library/pnpm",
        ".yarn/bin",
        ".yarn/berry/global/node_modules/.bin",
        ".config/yarn/global/node_modules/.bin",
        ".local/share/yarn/global/node_modules/.bin",
        ".npm-global/bin",
        ".npm/bin",
        ".nix-profile/bin",
        ".local/state/nix/profiles/profile/bin",
        ".linuxbrew/bin",
        ".n/bin",
    ] {
        push_directory(&mut directories, home.join(relative));
    }

    append_versioned_bins(&home.join(".nvm/versions/node"), &["bin"], &mut directories);
    append_versioned_bins(
        &home.join(".fnm/node-versions"),
        &["installation", "bin"],
        &mut directories,
    );
    append_versioned_bins(
        &home.join(".local/share/fnm/node-versions"),
        &["installation", "bin"],
        &mut directories,
    );
    append_versioned_bins(
        &home.join("Library/Application Support/fnm/node-versions"),
        &["installation", "bin"],
        &mut directories,
    );
    append_versioned_bins(
        &home.join(".asdf/installs/nodejs"),
        &["bin"],
        &mut directories,
    );
    append_versioned_bins(&home.join(".nodenv/versions"), &["bin"], &mut directories);
    append_versioned_bins(&home.join(".n/versions/node"), &["bin"], &mut directories);
    append_versioned_bins(
        &home.join(".local/share/mise/installs/node"),
        &["bin"],
        &mut directories,
    );
    directories
}

fn append_configured_directories(home: &Path, directories: &mut Vec<PathBuf>) {
    for name in [
        "CODEX_INSTALL_DIR",
        "OPENCODE_INSTALL_DIR",
        "XDG_BIN_DIR",
        "XDG_BIN_HOME",
        "PNPM_HOME",
        "NVM_BIN",
        "FNM_MULTISHELL_PATH",
    ] {
        append_env_directory(name, home, directories);
    }

    for name in ["BUN_INSTALL", "VOLTA_HOME"] {
        if let Some(root) = env::var_os(name)
            .as_deref()
            .and_then(|value| expand_home(value, Some(home)))
        {
            push_directory(directories, root.join("bin"));
        }
    }

    if let Some(root) = env::var_os("HOMEBREW_PREFIX")
        .as_deref()
        .and_then(|value| expand_home(value, Some(home)))
    {
        push_directory(directories, root.join("bin"));
        push_directory(directories, root.join("sbin"));
    }

    for name in ["ASDF_DATA_DIR", "MISE_DATA_DIR"] {
        if let Some(root) = env::var_os(name)
            .as_deref()
            .and_then(|value| expand_home(value, Some(home)))
        {
            push_directory(directories, root.join("shims"));
            let installs = if name == "ASDF_DATA_DIR" {
                root.join("installs/nodejs")
            } else {
                root.join("installs/node")
            };
            append_versioned_bins(&installs, &["bin"], directories);
        }
    }

    for name in ["FNM_DIR", "NVM_DIR"] {
        if let Some(root) = env::var_os(name)
            .as_deref()
            .and_then(|value| expand_home(value, Some(home)))
        {
            if name == "NVM_DIR" {
                append_versioned_bins(&root.join("versions/node"), &["bin"], directories);
            } else {
                append_versioned_bins(
                    &root.join("node-versions"),
                    &["installation", "bin"],
                    directories,
                );
            }
        }
    }

    if let Some(data_home) = env::var_os("XDG_DATA_HOME")
        .as_deref()
        .and_then(|value| expand_home(value, Some(home)))
    {
        push_directory(directories, data_home.join("mise/shims"));
        append_versioned_bins(&data_home.join("mise/installs/node"), &["bin"], directories);
        append_versioned_bins(
            &data_home.join("fnm/node-versions"),
            &["installation", "bin"],
            directories,
        );
        push_directory(directories, data_home.join("yarn/global/node_modules/.bin"));
    }

    if let Some(global_folder) = env::var_os("YARN_GLOBAL_FOLDER")
        .as_deref()
        .and_then(|value| expand_home(value, Some(home)))
    {
        push_directory(directories, global_folder.join("node_modules/.bin"));
    }

    if let Some(prefix) = env::var_os("N_PREFIX")
        .as_deref()
        .and_then(|value| expand_home(value, Some(home)))
    {
        push_directory(directories, prefix.join("bin"));
        append_versioned_bins(&prefix.join("n/versions/node"), &["bin"], directories);
    }

    if let Some(profile) = env::var_os("NIX_PROFILE").map(PathBuf::from) {
        push_directory(directories, profile.join("bin"));
    }
    if let Some(profiles) = env::var_os("NIX_PROFILES") {
        for profile in env::split_paths(&profiles) {
            push_directory(directories, profile.join("bin"));
        }
    }

    for name in ["NPM_CONFIG_PREFIX", "npm_config_prefix"] {
        if let Some(prefix) = env::var_os(name)
            .as_deref()
            .and_then(|value| expand_home(value, Some(home)))
        {
            append_npm_prefix(&prefix, directories);
        }
    }

    if let Some(config) =
        env::var_os("NPM_CONFIG_USERCONFIG").or_else(|| env::var_os("npm_config_userconfig"))
    {
        let path = expand_home(&config, Some(home)).unwrap_or_else(|| PathBuf::from(config));
        append_npmrc_prefix(&path, home, directories);
    } else {
        append_npmrc_prefix(&home.join(".npmrc"), home, directories);
    }
}

fn append_codex_directories(home: &Path, directories: &mut Vec<PathBuf>) {
    let codex_home = env::var_os("CODEX_HOME")
        .as_deref()
        .and_then(|value| expand_home(value, Some(home)))
        .unwrap_or_else(|| home.join(".codex"));
    let standalone = codex_home.join("packages/standalone");
    push_directory(directories, standalone.join("current/bin"));
    append_versioned_bins(&standalone.join("releases"), &["bin"], directories);
}

fn append_env_directory(name: &str, home: &Path, directories: &mut Vec<PathBuf>) {
    if let Some(path) = env::var_os(name)
        .as_deref()
        .and_then(|value| expand_home(value, Some(home)))
    {
        push_directory(directories, path);
    }
}

fn append_npm_prefix(prefix: &Path, directories: &mut Vec<PathBuf>) {
    #[cfg(windows)]
    push_directory(directories, prefix.to_path_buf());
    #[cfg(not(windows))]
    push_directory(directories, prefix.join("bin"));
}

fn append_npmrc_prefix(path: &Path, home: &Path, directories: &mut Vec<PathBuf>) {
    let Ok(contents) = fs::read_to_string(path) else {
        return;
    };

    for line in contents.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != "prefix" {
            continue;
        }
        let value = value.trim().trim_matches(['"', '\'']);
        if let Some(prefix) = expand_config_path(value, home) {
            append_npm_prefix(&prefix, directories);
        }
    }
}

fn expand_config_path(value: &str, home: &Path) -> Option<PathBuf> {
    let mut expanded = String::with_capacity(value.len());
    let mut remaining = value;
    while let Some(start) = remaining.find("${") {
        expanded.push_str(&remaining[..start]);
        let after_start = &remaining[start + 2..];
        let end = after_start.find('}')?;
        let name = &after_start[..end];
        let replacement = if name == "HOME" {
            Some(home.as_os_str().to_string_lossy().into_owned())
        } else if name == "USERPROFILE" {
            env::var_os(name).map(|path| path.to_string_lossy().into_owned())
        } else {
            env::var_os(name).map(|value| value.to_string_lossy().into_owned())
        }?;
        expanded.push_str(&replacement);
        remaining = &after_start[end + 1..];
    }
    expanded.push_str(remaining);

    if let Some(relative) = expanded.strip_prefix("~/") {
        return Some(home.join(relative));
    }
    let path = PathBuf::from(expanded);
    path.is_absolute().then_some(path)
}

fn append_versioned_bins(root: &Path, suffix: &[&str], directories: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut versions = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    versions.sort_by(|left, right| compare_versions(right, left));

    for mut version in versions {
        for part in suffix {
            version.push(part);
        }
        if version.is_dir() {
            push_directory(directories, version);
        }
    }
}

fn compare_versions(left: &Path, right: &Path) -> std::cmp::Ordering {
    let left = left
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .trim_start_matches('v');
    let right = right
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .trim_start_matches('v');
    let left_parts = left.split(['.', '-', '+']).collect::<Vec<_>>();
    let right_parts = right.split(['.', '-', '+']).collect::<Vec<_>>();
    for (left, right) in left_parts.iter().zip(&right_parts) {
        let order = match (left.parse::<u64>(), right.parse::<u64>()) {
            (Ok(left), Ok(right)) => left.cmp(&right),
            _ => left.cmp(right),
        };
        if !order.is_eq() {
            return order;
        }
    }
    left_parts.len().cmp(&right_parts.len())
}

fn append_platform_directories(directories: &mut Vec<PathBuf>) {
    #[cfg(target_os = "macos")]
    for path in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/opt/local/bin",
        "/sw/bin",
    ] {
        push_directory(directories, PathBuf::from(path));
    }

    #[cfg(target_os = "linux")]
    for path in [
        "/home/linuxbrew/.linuxbrew/bin",
        "/home/linuxbrew/.linuxbrew/sbin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/snap/bin",
        "/nix/var/nix/profiles/default/bin",
        "/run/current-system/sw/bin",
    ] {
        push_directory(directories, PathBuf::from(path));
    }

    #[cfg(windows)]
    {
        if let Some(root) = env::var_os("SystemRoot").map(PathBuf::from) {
            push_directory(directories, root.join("System32"));
        }
        for (name, relative) in [
            ("APPDATA", "npm"),
            ("USERPROFILE", "scoop/shims"),
            ("LOCALAPPDATA", "Volta/bin"),
            ("LOCALAPPDATA", "Microsoft/WinGet/Links"),
        ] {
            if let Some(root) = env::var_os(name).map(PathBuf::from) {
                push_directory(directories, root.join(relative));
            }
        }
        for name in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = env::var_os(name).map(PathBuf::from) {
                push_directory(directories, root.join("nodejs"));
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn launchd_path() -> Option<OsString> {
    let output = Command::new("/bin/launchctl")
        .args(["getenv", "PATH"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!value.is_empty()).then(|| OsString::from(value))
}

fn candidate_paths(
    executable: &str,
    explicit_path: Option<&Path>,
    directories: &[PathBuf],
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let requested = Path::new(executable);
    if requested.is_absolute() {
        append_executable_candidate(&mut candidates, requested.to_path_buf());
        return candidates;
    }
    if requested.components().count() > 1 {
        if let Ok(current) = env::current_dir() {
            append_executable_candidate(&mut candidates, current.join(requested));
        }
        return candidates;
    }

    if let Some(path) = explicit_path {
        if path.is_absolute() {
            append_executable_candidate(&mut candidates, path.to_path_buf());
            return candidates;
        }
    }

    for directory in directories {
        for path in executable_names(directory, executable) {
            append_executable_candidate(&mut candidates, path);
        }
    }
    candidates
}

fn executable_names(directory: &Path, executable: &str) -> Vec<PathBuf> {
    let path = Path::new(executable);
    #[cfg(windows)]
    {
        let mut candidates = vec![directory.join(path)];
        if path.extension().is_none() {
            let extensions =
                env::var_os("PATHEXT").unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"));
            candidates.extend(
                extensions
                    .to_string_lossy()
                    .split(';')
                    .map(|extension| directory.join(format!("{executable}{extension}"))),
            );
        }
        candidates
    }
    #[cfg(not(windows))]
    {
        vec![directory.join(path)]
    }
}

fn append_executable_candidate(candidates: &mut Vec<PathBuf>, path: PathBuf) {
    if path.is_absolute() && is_executable_file(&path) && !candidates.contains(&path) {
        candidates.push(path);
    }
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn push_directory(directories: &mut Vec<PathBuf>, path: PathBuf) {
    if path.is_absolute() && !directories.contains(&path) {
        directories.push(path);
    }
}

fn deduplicate(directories: &mut Vec<PathBuf>) {
    let mut unique = Vec::with_capacity(directories.len());
    for path in directories.drain(..) {
        push_directory(&mut unique, path);
    }
    *directories = unique;
}

fn expand_home(value: &OsStr, home: Option<&Path>) -> Option<PathBuf> {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        return Some(path);
    }
    let value = value.to_string_lossy();
    let relative = value.strip_prefix("~/")?;
    Some(home?.join(relative))
}

#[cfg(test)]
fn resolve_in_paths(
    executable: &str,
    explicit_path: Option<&Path>,
    directories: &[PathBuf],
) -> Option<PathBuf> {
    candidate_paths(executable, explicit_path, directories)
        .into_iter()
        .next()
}

#[cfg(all(test, unix))]
mod tests {
    use std::ffi::OsStr;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::path::{Path, PathBuf};

    use super::{
        append_npmrc_prefix, expand_home, resolve_in_paths, user_search_directories,
        ResolvedExecutable,
    };

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(name: &str) -> Self {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../.temp/cli-path-tests")
                .join(format!("{name}-{}", std::process::id()));
            fs::create_dir_all(&root).expect("create repository-local test fixture");
            Self(root)
        }

        fn home(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn executable(path: &Path) {
        executable_with_contents(path, "#!/bin/sh\nprintf 'fixture-version\\n'\n");
    }

    fn executable_with_contents(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().expect("executable parent"))
            .expect("create executable directory");
        fs::write(path, contents).expect("write executable fixture");
        let mut permissions = fs::metadata(path)
            .expect("executable metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).expect("make fixture executable");
    }

    #[test]
    fn finds_codex_in_its_standalone_install_directory_without_gui_path_entries() {
        let fixture = Fixture::new("codex-standalone");
        let path = fixture.home().join(".local/bin/codex");
        executable(&path);

        let directories = user_search_directories(fixture.home());
        let resolved = resolve_in_paths("codex", None, &directories);

        assert_eq!(resolved.as_deref(), Some(path.as_path()));
    }

    #[test]
    fn finds_opencode_in_its_standalone_install_directory_without_gui_path_entries() {
        let fixture = Fixture::new("opencode-standalone");
        let path = fixture.home().join(".opencode/bin/opencode");
        executable(&path);

        let directories = user_search_directories(fixture.home());
        let resolved = resolve_in_paths("opencode", None, &directories);

        assert_eq!(resolved.as_deref(), Some(path.as_path()));
    }

    #[test]
    fn honors_an_explicit_absolute_executable_path_outside_all_search_directories() {
        let fixture = Fixture::new("absolute-override");
        let path = fixture.home().join("custom tools/codex");
        executable(&path);

        let resolved = resolve_in_paths("codex", Some(&path), &[]);

        assert_eq!(resolved.as_deref(), Some(path.as_path()));
    }

    #[test]
    fn resolves_an_absolute_executable_path_containing_spaces() {
        let fixture = Fixture::new("absolute-executable");
        let path = fixture.home().join("custom tools/opencode");
        executable(&path);
        let executable_path = path.to_string_lossy();

        let resolved = resolve_in_paths(&executable_path, None, &[]);

        assert_eq!(resolved.as_deref(), Some(path.as_path()));
    }

    #[test]
    fn an_absolute_executable_argument_takes_precedence_over_a_configured_override() {
        let fixture = Fixture::new("absolute-priority");
        let requested = fixture.home().join("requested/codex");
        let override_path = fixture.home().join("override/codex");
        executable(&requested);
        executable(&override_path);

        let resolved = resolve_in_paths(
            "codex",
            Some(&override_path),
            std::slice::from_ref(&requested),
        );

        assert_eq!(
            resolve_in_paths(&requested.to_string_lossy(), Some(&override_path), &[]),
            Some(requested)
        );
        assert_eq!(resolved, Some(override_path));
    }

    #[test]
    fn preserves_a_symlink_invocation_path() {
        let fixture = Fixture::new("symlink-path");
        let target = fixture.home().join("package-manager/codex");
        let link = fixture.home().join(".local/bin/codex");
        executable(&target);
        fs::create_dir_all(link.parent().expect("symlink parent"))
            .expect("create symlink directory");
        symlink(&target, &link).expect("create executable symlink");

        let directories = user_search_directories(fixture.home());
        let resolved = resolve_in_paths("codex", None, &directories);

        assert_eq!(resolved.as_deref(), Some(link.as_path()));
    }

    #[test]
    fn expands_a_home_relative_executable_override() {
        let fixture = Fixture::new("home-override");
        let expanded = expand_home(OsStr::new("~/.local/bin/codex"), Some(fixture.home()));

        assert_eq!(expanded, Some(fixture.home().join(".local/bin/codex")));
    }

    #[test]
    fn an_invalid_absolute_override_does_not_silently_select_another_install() {
        let fixture = Fixture::new("invalid-override");
        let fallback = fixture.home().join("fallback/codex");
        executable(&fallback);
        let override_path = fixture.home().join("missing/codex");

        let resolved = resolve_in_paths(
            "codex",
            Some(&override_path),
            &[fixture.home().join("fallback")],
        );

        assert!(resolved.is_none());
    }

    #[test]
    fn uses_the_highest_semver_node_manager_bin_when_the_gui_path_is_sparse() {
        let fixture = Fixture::new("nvm-bins");
        let older = fixture.home().join(".nvm/versions/node/v9.9.0/bin/codex");
        let newer = fixture.home().join(".nvm/versions/node/v20.10.0/bin/codex");
        executable(&older);
        executable(&newer);

        let directories = user_search_directories(fixture.home());
        let resolved = resolve_in_paths("codex", None, &directories);

        assert_eq!(resolved.as_deref(), Some(newer.as_path()));
    }

    #[test]
    fn discovers_npm_global_bins_from_npmrc_home_interpolation() {
        let fixture = Fixture::new("npmrc-prefix");
        let prefix = fixture.home().join("custom npm prefix");
        let path = prefix.join("bin/codex");
        executable(&path);
        let npmrc = fixture.home().join(".npmrc");
        fs::write(&npmrc, "prefix=${HOME}/custom npm prefix\n").expect("write npm config");
        let mut directories = Vec::new();

        append_npmrc_prefix(&npmrc, fixture.home(), &mut directories);
        let resolved = resolve_in_paths("codex", None, &directories);

        assert_eq!(resolved.as_deref(), Some(path.as_path()));
    }

    #[test]
    fn executes_a_resolved_path_with_spaces_and_preserves_the_child_path() {
        let fixture = Fixture::new("absolute-execution");
        let bin = fixture.home().join("custom tools/bin");
        let path = bin.join("codex");
        let node = bin.join("node");
        executable_with_contents(&path, "#!/usr/bin/env node\n");
        executable_with_contents(&node, "#!/bin/sh\nprintf 'node-runtime-found\\n'\n");
        let resolved = ResolvedExecutable {
            path,
            search_path: bin.into_os_string(),
        };

        let output = resolved
            .command()
            .arg("--version")
            .output()
            .expect("run the absolute CLI shim");

        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "node-runtime-found"
        );
    }
}
