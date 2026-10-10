//! Application modules, one per bounded capability.
//!
//! Each is a directory with a `mod.rs` that is its public surface; leaf files
//! stay private so they can be replaced without touching callers. Sibling
//! modules never import each other — they meet at the traits in `shared/`.

pub mod automation;
pub mod commands;
pub mod onboarding;
pub mod providers;
pub mod settings;
pub mod widget;
