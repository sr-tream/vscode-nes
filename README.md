## NESweep — Next Edit autocompletion for VSCode

<img width="563" height="327" alt="image" src="https://github.com/user-attachments/assets/9a06ed4a-bf9b-41e0-a21b-2178cb2c67b9" />

NESweep is a fork of [Sweep Next Edit](https://github.com/sweepai/vscode-nes)
that retargets the extension at a local OpenAI-compatible
`/v1/completions` server (e.g. llama.cpp's `llama-server`) running an
edit-prediction model. The upstream `uvx sweep-autocomplete` Python
child process — which falls back to CPU and is unusable for next-edit
latency — is removed.

## Features

- **Local OpenAI-compatible backend.** Posts to `/v1/completions` on
  any server you bring up (llama.cpp, vLLM, sglang, Ollama with the
  OpenAI shim).
- **SweepAI + Zed Zeta-2 / Zeta-2.1 models.** Format auto-detected
  from `sweep.modelName`. Zeta-2.1 returns up to three edits per
  request (cursor area + up to two windows around nearby diagnostics).
- **LSP-diagnostics aware.** Cursor-radius filter, cascading-error
  suppression below a root-cause line, and user-configurable regex
  rewrites on the messages (clang / clang-tidy presets included).
- **Per-language workspace rules.** `.vscode/nes-<languageId>.md`
  is editable from the NESweep status-bar menu with a configurable
  soft-cap warning when the file grows large enough to bloat latency.
- **Cache-friendly + persistent.** Stable content emitted first /
  volatile last for maximum prefix-cache hits; recent files, edits,
  and cursor positions survive window reload via `workspaceState`,
  so the model has context immediately after restart.
- **Status-bar menu + trace logging.** Toggle, snooze, ping server,
  edit instructions. Set the NESweep output channel to `Trace`
  (`Developer: Set Log Level… → NESweep`) for full request/response
  visibility.

## Settings

| Key | Default | Purpose |
| --- | --- | --- |
| `sweep.serverUrl` | `http://localhost:8080` | `/v1/completions` base URL |
| `sweep.modelName` | `sweepai/sweep-next-edit` | `model` field in the request body; substring-matched to pick the prompt format |
| `sweep.completionTimeoutMs` | `10000` | Per-request timeout (ms) |
| `sweep.maxRecentChangesChars` | `12000` | Character budget for formatted recent-edit history; `0` disables history |
| `sweep.includeClipboardContext` | `true` | Include clipboard text as retrieval context; it is emitted last in retrieval |
| `sweep.stableRetrievalOrdering` | `false` | Sort retrieval chunks deterministically to improve prefix-cache reuse |
| `sweep.reuseIdenticalPromptResults` | `false` | Reuse recent temperature-0 results for byte-identical prompts |
| `sweep.identicalPromptCacheTtlMs` | `5000` | TTL for identical-prompt result reuse |
| `sweep.diagRadius` | `12` | ±N lines around cursor; `0` disables |
| `sweep.broadBefore` | `125` | Lines of broad context before cursor |
| `sweep.broadAfter` | `75` | Lines of broad context after cursor |
| `sweep.rulesMaxChars` | `3000` | Soft cap on per-language workspace-rules file size; overflow surfaces as a diagnostic + red background in the editor |
| `sweep.injectInlineDiagnostics` | `false` | Inline `BUG:` comments next to diagnosed lines in the prompt — recommended for 0.5B / 1.5B sweep checkpoints |
| `sweep.inlineDiagnosticsMarker` | `BUG: LSP error here` | Marker phrase used by the inline injection + response-side strip anchor |
| `sweep.diagnosticsMessageTransforms` | clang preset | `{regex: replacement}` rewrites applied to every diagnostic message after the built-in normalisations |

## Setup

Run any supported edit-prediction GGUF behind an OpenAI-compatible
`/v1/completions` server. Examples with llama.cpp:

```sh
# Sweep next-edit (default; 7B works without the inline-diagnostics hack)
llama-server -hf sweepai/sweep-next-edit-7b-gguf --ctx-size 32768

# Sweep 1.5B (smaller, faster — turn on sweep.injectInlineDiagnostics)
llama-server -hf sweepai/sweep-next-edit-1.5b-gguf --ctx-size 32768

# Zeta-2 (Zed's SeedCoder-8B, single-region)
llama-server -hf bartowski/zed-industries_zeta-2-GGUF --ctx-size 16384

# Zeta-2.1 (Zed's SeedCoder-8B, multi-region)
llama-server -hf bartowski/zed-industries_zeta-2.1-GGUF --ctx-size 16384
```

Then point `sweep.modelName` at the right name. Detection rules:

- `zeta-2.1` / `zeta2.1` / `zeta-2-1` / `zeta_2_1` → Zeta-2.1 multi-region
- `zeta2` / `zeta-2` / `seedcoder` → Zeta-2 single-region
- everything else → Sweep layout (default)

Sweep's GGUF advertises 32k natively; the full prompt routinely runs
15–20k tokens for non-trivial files, so a smaller `--ctx-size`
truncates real prompts. Zeta-2 / 2.1's editable regions are much
tighter (±15 lines around cursor + tiny ±2-line halos for diagnostic
regions on 2.1), so those prompts are smaller.

Build & install the extension:

```sh
bun install
bun run build
bunx @vscode/vsce package --no-dependencies --skip-license
code --install-extension nesweep-*.vsix --force
```

## Credits

- Original [Sweep Next Edit](https://github.com/sweepai/vscode-nes)
  by [SweepAI](https://github.com/sweepai).
- Sweep prompt format ported from
  [cursortab.nvim](https://github.com/cursortab/cursortab.nvim).
- Zeta-2 / Zeta-2.1 model card: [zed-industries on Hugging Face](https://huggingface.co/zed-industries).

## License

GNU Affero General Public License v3.0 or later — see [LICENSE](LICENSE).

The upstream repository [`sweepai/vscode-nes`](https://github.com/sweepai/vscode-nes)
does not ship a LICENSE file, but its initial commit
([`fcdfb50`](https://github.com/sweepai/vscode-nes/commit/fcdfb50) —
`init: Base vscode foundation based on zed impl`) is a line-for-line
TypeScript translation of
[`zed-industries/zed/crates/zeta/src/sweep_ai.rs`](https://github.com/zed-industries/zed/blob/76167109db7b/crates/zeta/src/sweep_ai.rs)
— the wire-protocol structs, the `ActionType` enum with its
`SCREAMING_SNAKE_CASE` serde rename, the brotli `(quality=11,
lgwin=22)` params, the hardcoded `https://autocomplete.sweep.dev/...`
endpoint, even the `// TODO`-fenced `privacy_mode_enabled: false`
were carried over verbatim. The Rust file was removed from Zed in
commit
[`42583c1`](https://github.com/zed-industries/zed/commit/42583c1)
on 2025-12-04, but at the time of the initial commit it was AGPL-3.0
as part of the Zed editor. Translating an AGPL work into another
language produces a derivative work covered by the same license, so
AGPL-3.0 attaches to the entire combined codebase regardless of
whether the upstream author shipped a LICENSE file. This fork makes
that licensing explicit.

Copyright attribution:

- Zed Industries, Inc. — original `sweep_ai.rs` (AGPL-3.0), ported in
  `src/api/schemas.ts`, `src/core/constants.ts`, and parts of
  `src/api/client.ts`.
- SweepAI and the upstream `sweepai/vscode-nes` contributors —
  VS Code-side glue (extension activation, inline-edit provider,
  document tracker, telemetry plumbing), itself a combined work
  covered by the same AGPL terms.
- This fork's authors — all subsequent commits.
