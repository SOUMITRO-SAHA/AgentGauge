//! The app's root error taxonomy.
//!
//! Every module defines one concrete error enum and converts up into
//! [`Error`] with `#[from]`. Callers match on variants — never on message
//! strings. The `kind` field is what crosses IPC, so the client branches on a
//! stable tag rather than parsing prose.

use std::fmt;

use serde::{Deserialize, Serialize};

/// Why an operation failed, in a form the renderer can branch on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// The `codex` executable is not on `PATH`, or could not be spawned.
    ProviderMissing,
    /// The child process died or its stdio closed unexpectedly.
    TransportClosed,
    /// The provider replied, but with an error frame.
    ProviderError,
    /// The provider replied with a payload we cannot decode.
    InvalidPayload,
    /// The operation exceeded its deadline.
    Timeout,
    /// Local persistence failed.
    Storage,
    /// The request was not valid.
    InvalidRequest,
    /// The system widget's snapshot could not be published.
    Widget,
}

impl ErrorKind {
    /// The wire tag, matching the `rename_all = "camelCase"` serde attribute on
    /// the enum.
    ///
    /// Kept as an explicit function, and asserted against serde's own output in
    /// the tests below, so a client matching on the string and a log line
    /// reading the enum can never disagree.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ProviderMissing => "providerMissing",
            Self::TransportClosed => "transportClosed",
            Self::ProviderError => "providerError",
            Self::InvalidPayload => "invalidPayload",
            Self::Timeout => "timeout",
            Self::Storage => "storage",
            Self::InvalidRequest => "invalidRequest",
            Self::Widget => "widget",
        }
    }
}

/// The app-wide error. Deliberately free of provider-specific detail so it can
/// cross the IPC boundary without leaking payloads or paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Error {
    pub kind: ErrorKind,
    /// Actionable context for the user. Never contains secrets or raw provider
    /// response bodies.
    pub message: String,
}

impl Error {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn provider_missing(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::ProviderMissing, message)
    }

    pub fn transport_closed(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::TransportClosed, message)
    }

    pub fn provider_error(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::ProviderError, message)
    }

    pub fn invalid_payload(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::InvalidPayload, message)
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Timeout, message)
    }

    pub fn storage(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Storage, message)
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::InvalidRequest, message)
    }

    pub fn widget(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Widget, message)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for Error {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_a_tagged_shape_not_a_bare_string() {
        let json = serde_json::to_value(Error::timeout("no reply")).expect("serializes");
        assert_eq!(json["kind"], "timeout");
        assert_eq!(json["message"], "no reply");
    }

    #[test]
    fn round_trips_through_serde() {
        let original = Error::provider_missing("codex not on PATH");
        let json = serde_json::to_string(&original).expect("serializes");
        let decoded: Error = serde_json::from_str(&json).expect("deserializes");
        assert_eq!(decoded, original);
    }

    #[test]
    fn kind_tags_are_stable() {
        // These strings are a client-facing contract.
        assert_eq!(ErrorKind::ProviderMissing.as_str(), "providerMissing");
        assert_eq!(ErrorKind::TransportClosed.as_str(), "transportClosed");
        assert_eq!(ErrorKind::InvalidPayload.as_str(), "invalidPayload");
    }

    #[test]
    fn as_str_agrees_with_the_serde_tag_for_every_kind() {
        // If these two ever diverge, a client matching on one and a log line
        // reading the other would disagree about the failure.
        let all = [
            ErrorKind::ProviderMissing,
            ErrorKind::TransportClosed,
            ErrorKind::ProviderError,
            ErrorKind::InvalidPayload,
            ErrorKind::Timeout,
            ErrorKind::Storage,
            ErrorKind::InvalidRequest,
            ErrorKind::Widget,
        ];
        for kind in all {
            let serialized = serde_json::to_value(Error::new(kind, "x")).expect("serializes");
            assert_eq!(serialized["kind"], kind.as_str());
        }
    }

    #[test]
    fn every_error_constructor_tags_itself_correctly() {
        assert_eq!(
            Error::provider_missing("m").kind,
            ErrorKind::ProviderMissing
        );
        assert_eq!(
            Error::transport_closed("m").kind,
            ErrorKind::TransportClosed
        );
        assert_eq!(Error::provider_error("m").kind, ErrorKind::ProviderError);
        assert_eq!(Error::invalid_payload("m").kind, ErrorKind::InvalidPayload);
        assert_eq!(Error::timeout("m").kind, ErrorKind::Timeout);
        assert_eq!(Error::storage("m").kind, ErrorKind::Storage);
        assert_eq!(Error::invalid_request("m").kind, ErrorKind::InvalidRequest);
        assert_eq!(Error::widget("m").kind, ErrorKind::Widget);
    }
}
