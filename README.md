## NESweep — Next Edit autocompletion for VSCode

<img width="563" height="327" alt="image" src="https://github.com/user-attachments/assets/9a06ed4a-bf9b-41e0-a21b-2178cb2c67b9" />

NESweep is a fork of [Sweep Next Edit](https://github.com/sweepai/vscode-nes)
that retargets the extension at a local OpenAI-compatible
`/v1/completions` server (e.g. llama.cpp's `llama-server`) running the
sweep GGUF, removing the upstream `uvx sweep-autocomplete` Python child
process (which falls back to CPU and is unusable for next-edit
latency).

The sweep prompt format (broad context, retrieval, diagnostics, diff
history, and the `original/current/updated` triplet with cursor marker
and prefill) is ported from
[cursortab.nvim](https://github.com/cursortab/cursortab.nvim)'s sweep
provider.

## Features

### Backend

- **OpenAI-compatible `/v1/completions`.** The extension posts to a
  single endpoint with `model / prompt / temperature / max_tokens /
  stop`. Context size and idle eviction are server-side concerns
  (e.g. llama-server's `--ctx-size`), so neither `num_ctx` nor
  `keep_alive` are sent.
- **Sweep prompt built in TypeScript.** Broad file context, retrieval
  (open editors + LSP definitions/usages + clipboard), diagnostics,
  recent-changes diff history, and the `original/current/updated`
  triplet with cursor marker and prefill — all assembled directly from
  VSCode's API.
- **Token-usage log.** Each completion logs `prompt_tokens` /
  `completion_tokens` (from `usage`) to the Extension Host so it's
  easy to confirm prompts fit inside the server's context window.

### Prompt shaping

- **`diagRadius=12`.** VSCode hands every diagnostic on the file to the
  prompt; this filter drops entries whose `Line N:` is more than ±N
  from the cursor.
- **`broadBefore=125 / broadAfter=75`.** Asymmetric trim of the leading
  `<|file_sep|>{path}` broad-context section, biased behind the cursor.
  The `original/current/updated` edit window is unaffected.
- **Reject `finish_reason=length`.** A truncated response gives a
  corrupt line-diff (window tail no longer matches the model output),
  so we drop it instead of producing a destructive edit.

### Edit-window post-processing

- **Line-diff trim.** The model usually re-emits the whole edit window
  with one or two lines changed. We compute the longest common prefix
  and suffix of the new vs. old window lines and return only the
  changed middle as the edit. Insertions splice in with a trailing
  `\n`; deletions gobble the trailing newline of the last removed line.
- **Cursor anchoring.** When the replacement starts before the cursor
  on the line that contains the cursor, the start is anchored to the
  cursor and the matching pre-cursor prefix is stripped from the
  completion, so accepting cleanly rewrites the line tail instead of
  inserting at the cursor and leaving the original tail in place.
- **Auto-retrigger after accept.** VSCode does not auto-fire the
  inline-completion provider for the text change that an accept itself
  applies, so after every accept we call
  `editor.action.inlineSuggest.trigger` to keep the next-edit loop
  alive.

### Workspace rules

- **`.vscode/nes-<languageId>.md`** — workspace-local rules.
  `<languageId>` is VS Code's document language id (`cpp`, `lua`,
  `javascript`, `typescript`, `python`, …), so e.g. a `.h` file
  resolves to `nes-cpp.md` alongside `.cpp`. The body is wrapped in
  the language's single-line comment syntax (`//`, `--`, `#`) and
  emitted as a sibling section
  `<|file_sep|>context/rules\n…` placed right before the
  `original/current/updated` triplet, alongside `context/retrieval` /
  `context/diagnostics`. File reads are mtime-cached, so editing a
  rules file picks up on the next keystroke without reloading the
  window.

## Settings

| Key | Default | Purpose |
| --- | --- | --- |
| `sweep.serverUrl` | `http://localhost:8080` | `/v1/completions` base URL |
| `sweep.modelName` | `sweepai/sweep-next-edit` | `model` field in the request body |
| `sweep.completionTimeoutMs` | `10000` | Per-request timeout (ms) |
| `sweep.diagRadius` | `12` | ±N lines around cursor; `0` disables |
| `sweep.broadBefore` | `125` | Lines of broad context before cursor |
| `sweep.broadAfter` | `75` | Lines of broad context after cursor |

## Setup

Run the sweep GGUF behind any OpenAI-compatible `/v1/completions`
server. Example with llama.cpp:

```sh
llama-server -hf sweepai/sweep-next-edit-1.5b-gguf --ctx-size 32768
```

Sweep's GGUF advertises 32k natively; the full prompt (broad context +
retrieval + diagnostics + diff history + edit window) routinely runs
15–20k tokens for non-trivial files, so a smaller `--ctx-size`
truncates real prompts.

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
