//! Application modules, one per bounded capability.
//!
//! Each is a directory with a `mod.rs` that is its public surface; leaf files
//! stay private so they can be replaced without touching callers. Sibling
//! modules never import each other — they meet at the traits in `shared/`.

pub mod about;
#[cfg(all(target_os = "macos", debug_assertions))]
pub mod app_icon;
pub mod automation;
pub mod cli_detection;
pub mod commands;
pub mod kickoff;
pub mod onboarding;
pub mod opencode;
pub mod process_insights;
pub mod providers;
pub mod settings;
pub mod widget;
