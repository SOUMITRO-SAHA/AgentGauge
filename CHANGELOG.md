# Changelog

All notable changes to AgentGauge are documented in this file.

## Unreleased

### Fixed

- Returning users no longer see the onboarding flow on every app launch. The
  gate now keeps onboarding hidden while persisted progress is loading or if
  the read fails, and shows it only once the stored state confirms a first
  run. Regression coverage pins both the completed-user startup and the
  failed-read case.
