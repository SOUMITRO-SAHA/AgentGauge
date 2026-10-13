//! The headless background service registration and scheduling contract.

pub mod agent;

#[cfg(target_os = "macos")]
pub fn claim_service() -> Option<std::fs::File> {
    use std::os::fd::AsRawFd;
    let home = std::env::var_os("HOME")?;
    let directory = crate::shared::app_support::app_support_dir(&home);
    std::fs::create_dir_all(&directory).ok()?;
    let suffix = if cfg!(debug_assertions) { "-dev" } else { "" };
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(directory.join(format!("background-service{suffix}.lock")))
        .ok()?;
    // SAFETY: The descriptor stays open for the service lifetime; nonblocking exclusive lock prevents a second owner.
    (unsafe { flock(file.as_raw_fd(), 2 | 4) } == 0).then_some(file)
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn flock(fd: i32, operation: i32) -> i32;
}
