//! The single place this app makes an outbound HTTP request.
//!
//! Uses the client Tauri's http plugin ships — one vetted reqwest stack, no
//! hand-rolled transport — driven synchronously because the provider trait and
//! the dispatch command are synchronous by design.

use std::time::Duration;

use tauri::async_runtime;
use tauri_plugin_http::reqwest::{self, header};

use crate::shared::error::{Error, ErrorKind};

/// How the credential is presented, because the vendors differ: Z.AI
/// documents its quota endpoint must receive the raw key, MiniMax and Kimi
/// take the usual bearer form.
pub(crate) enum AuthHeader {
    Raw(String),
    Bearer(String),
}

/// Performs a GET and returns the body text.
///
/// A non-2xx status is returned as an `Err` with the status in the message —
/// the caller decides whether that is a failure or an explicit unavailable
/// state, because some vendors put business errors inside HTTP 200 and others
/// inside 401s.
pub(crate) fn get_json(url: &str, auth: &AuthHeader) -> Result<String, Error> {
    async_runtime::block_on(async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|error| {
                Error::new(
                    ErrorKind::TransportClosed,
                    format!("The HTTP client could not be created ({error})."),
                )
            })?;

        let mut request = client.get(url);
        request = match auth {
            AuthHeader::Raw(key) => request.header(header::AUTHORIZATION, key),
            AuthHeader::Bearer(key) => request.bearer_auth(key),
        };

        let response = request.send().await.map_err(|error| {
            Error::new(
                ErrorKind::TransportClosed,
                format!("The request to the plan's usage endpoint failed ({error})."),
            )
        })?;

        let status = response.status();
        let body = response.text().await.map_err(|error| {
            Error::new(
                ErrorKind::InvalidPayload,
                format!("The usage reply could not be read ({error})."),
            )
        })?;

        if !status.is_success() {
            return Err(Error::new(
                ErrorKind::ProviderError,
                format!("The usage endpoint answered HTTP {status}."),
            ));
        }
        Ok(body)
    })
}
