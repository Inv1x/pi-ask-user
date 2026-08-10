# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed

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
