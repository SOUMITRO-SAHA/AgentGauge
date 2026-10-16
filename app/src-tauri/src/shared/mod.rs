//! Cross-module primitives consumed by two or more modules.
//!
//! This tier holds values and contracts only: domain types, the error taxonomy,
//! the provider trait, the durable database, the clock, and the file logger.
//! It never imports from `modules/`, and it holds no capability of its own.

pub mod app_support;
pub mod bundle;
pub mod clock;
pub mod database;
pub mod domain;
pub mod error;
pub mod executable;
pub mod logging;
pub mod platform;
pub mod protocol;
pub mod provider;
