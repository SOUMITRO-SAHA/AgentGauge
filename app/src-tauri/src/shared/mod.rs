//! Cross-module primitives consumed by two or more modules.
//!
//! This tier holds values and contracts only: domain types, the error taxonomy,
//! the provider trait, and the clock. It never imports from `modules/`, and it
//! holds no capability of its own.

pub mod bundle;
pub mod clock;
pub mod domain;
pub mod error;
pub mod protocol;
pub mod provider;
