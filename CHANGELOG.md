# Changelog

## 0.3.0

### Minor Changes

- a75ca5a: Raise the minimum supported Pi version to 1.4.0 and pin the development SDK and lockfile to that release. Older Pi hosts are no longer supported. This baseline includes the host fix for concurrent extension dialogs leaving promises unresolved. Update real-runner tests to use Pi's tool execution context and check the installed Pi dependency tree in CI.

## 0.2.0

### Minor Changes

- Require Pi 0.87.1, test custom-prompt lifecycle events through ExtensionRunner, and return JSON-safe option descriptions and explicit dismissal reasons. Structured result `options` now contains `{ label, description }` records rather than label strings. Document automatic prompt lifecycle events and eligible cache warming during user waits.

### Patch Changes

- 8858c10: Defer questions while a TUI overlay is open so the topmost inspector keeps keyboard focus.
- 4f13f61: Adopt Changesets for version and changelog management.

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed

- Defer `ask_user` while a TUI overlay is open so the topmost fleet or terminal inspector keeps keyboard focus until it closes.
- Made nested option descriptions required-but-nullable so Codex/OpenAI strict tool-schema validation accepts `ask_user`.

### Changed

- Updated the tested Pi and TUI development baseline to 0.84.1 and TypeBox to 1.3.7.
- Added strict-preferred JSON Schema constrained sampling and closed tool parameter schemas.
- Made selection controls honor Pi's injected keybindings while retaining number shortcuts.
- Made rendering ANSI-, Unicode-, CJK-, narrow-width-, and fullscreen-width-change-aware.
- Sanitized unsafe terminal and bidirectional controls from displayed model-provided text.
- Added package metadata, CI, documentation, and a prepack quality gate.

### Tests

- Added coverage for remapped keys, tool metadata, display-width-safe rendering, unsafe controls, cancellation, and abort-listener cleanup.
