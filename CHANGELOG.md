# Changelog

Notable NESweep fork changes are documented here, starting from the fork point at `v0.5.0-fork.1`.

## 1.2.0 - 2026-06-19

- Added optional Copilot-style proposed inline edit presentation.
- Added a user-facing warning that the Copilot-style presentation depends on VS Code proposed API and requires VS Code Insiders with `--enable-proposed-api=sr-team.nesweep`.
- Added a configurable `sweep.maxRecentChangesChars` prompt budget for formatted recent-edit history, defaulting to `12000` characters.
- Truncated oversized recent-change history before sending completion requests so bulk edits cannot overflow small model contexts.

## 1.1.0 - 2026-05-18

- Rebalanced edit-history selection across active and recently edited files.
- Filtered non-editor URIs out of tracked recent-file context.
- Marked the extension with the Marketplace AI category.
- Fixed publisher metadata to match the `SR-team` Marketplace account.
- Refined NESweep icon artwork and status-bar glyphs.

## 1.0.0 - 2026-05-17

- Rebranded the extension with NESweep assets and iconography.
- Added animated status-bar feedback while inference is running.
- Simplified the status bar to the compact icon-only presentation.
- Added the inherited AGPL-3.0 license.
- Trimmed the README to focus on features and setup.

## 0.5.0-fork.3 - 2026-05-17

- Rebranded the fork to NESweep and simplified the backend around an OpenAI-compatible completion client.
- Added Zeta-2 and Zeta-2.1 prompt formats, including multi-region edit support and model-emitted cursor positions.
- Reordered prompt sections for prefix-cache friendliness.
- Normalized diagnostics and added optional inline diagnostic injection for smaller models.
- Added per-language workspace rules files, editor commands, and soft-cap diagnostics.
- Persisted `DocumentTracker` state across extension reloads.
- Routed extension logs through `vscode.LogOutputChannel`.
- Fixed prefix-typing ghost text, multi-line replacement routing, line-diff trailing newline alignment, and rules character counting.
- Removed dead telemetry tracker code and unused metrics schemas.

## 0.5.0-fork.2 - 2026-05-07

- Added llama.cpp/vLLM/sglang-style OpenAI-compatible `/v1/completions` backend support.
- Added in-flight request piggybacking for prefix-extension typing.
- Scaled retrieval-chunk size with the broad context window.
- Reduced the diagnostics cap to keep prompts compact.
- Fixed abort/timeout request cleanup.

## 0.5.0-fork.1 - 2026-05-05

- Forked from the upstream local-mode branch.
- Replaced the `uvx` Python autocomplete bridge with direct local backend calls.
- Documented the fork-specific backend and workspace-rule behavior.
