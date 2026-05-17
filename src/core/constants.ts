// Default configuration
export const DEFAULT_MAX_CONTEXT_FILES = 5;
export const DEFAULT_SERVER_URL = "http://localhost:8080";
export const DEFAULT_COMPLETION_TIMEOUT_MS = 10_000;
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

// Soft cap on per-language rules files. The body is wrapped as comments
// and spliced into the prefix of every completion prompt — cache-friendly
// on a server with prefix caching (llama.cpp -cpent, vLLM/sglang), so
// the steady-state cost is mainly the context budget consumed, plus a
// prompt-eval spike on each save (cache invalidation). ~3000 chars is
// roughly 1000 tokens on the Sweep tokenizer.
export const DEFAULT_RULES_MAX_CHARS = 3000;
