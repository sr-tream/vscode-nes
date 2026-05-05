// Sweep model tokens
export const SWEEP_FILE_SEP_TOKEN = "<|file_sep|>";
export const STOP_TOKENS = ["<|file_sep|>", "<|endoftext|>"];

// Default configuration
export const DEFAULT_MAX_CONTEXT_FILES = 5;
export const DEFAULT_BACKEND = "ollama";
export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_LLAMA_SERVER_URL = "http://localhost:8080";
// Sweep's GGUF advertises 32k natively. The full sweep prompt (broad file
// context + retrieval + diagnostics + diff history + original/current/
// updated windows) routinely runs 15–20k tokens for any non-trivial file —
// pinning 8k truncates the file body and yields delete-only completions.
export const DEFAULT_NUM_CTX = 32768;
// Keeps the model resident on the GPU between completions during an editing
// session.
export const DEFAULT_KEEP_ALIVE = "30m";
// First model load with num_ctx=32k allocates a much larger KV cache than
// Ollama's host default and routinely takes 20–40s to come up. Subsequent
// calls within keep_alive return in 2–8s. 60s gives the cold path enough
// headroom; real hangs still surface within the keep_alive window.
export const DEFAULT_COMPLETION_TIMEOUT_MS = 60_000;
// Drop diagnostics whose line is more than this many lines from the cursor.
// VSCode hands us the entire file's diagnostic set per request; keeping all
// of them dominates the prompt for files with a chatty linter.
export const DEFAULT_DIAG_RADIUS = 12;
// Asymmetric trim of the leading <|file_sep|>{path} broad-context section.
// Cursortab hardcodes ±150; we bias behind the cursor where prediction
// context typically lives.
export const DEFAULT_BROAD_BEFORE = 125;
export const DEFAULT_BROAD_AFTER = 75;

// Model parameters
export const MODEL_NAME = "sweepai/sweep-next-edit";
// Stay generous: the sweep model rewrites the whole edit window even when
// only one line changed, so a too-low cap truncates mid-window. Without
// cursortab's anchor-based truncation handling, a truncated response yields
// a corrupt line-diff (window tail no longer matches), so we just reject
// finish_reason=length completions in sweep-completion. Keep num_predict
// high enough that healthy responses never hit this cap.
export const MAX_TOKENS = 2048;
export const TEMPERATURE = 0.0;

// File size guards (match JetBrains defaults)
export const AUTOCOMPLETE_MAX_FILE_SIZE = 10_000_000;
export const AUTOCOMPLETE_MAX_LINES = 50_000;
export const AUTOCOMPLETE_AVG_LINE_LENGTH_THRESHOLD = 240;
