// Selects which prompt-format dialect we speak based on the configured
// model name. Each backend (sweep next-edit, Zed's Zeta2 SeedCoder) has its
// own prompt layout and stop tokens, but they share the same response shape
// (replace a slice of the buffer with new lines), so dispatch happens at
// prompt-builder + response-parser level only.

export type ModelFormat = "sweep" | "zeta2";

export interface PromptLine {
	startByte: number;
	content: string;
}

// Common output of every prompt builder. The response parser uses
// windowStartLine / windowEndLine + lines + cursorLineByteOffsets to map
// the model's text output back to a byte-offset edit on the user's buffer.
export interface ModelPrompt {
	prompt: string;
	// Text the model is expected to "continue" from. Sweep uses this to seed
	// the updated/{path} section; Zeta2's FIM layout has nothing to prefill,
	// so this is "" for that format.
	prefill: string;
	format: ModelFormat;
	stopTokens: string[];
	// Line range (0-indexed half-open) the response replaces. For sweep this
	// is the full original/current/updated window; for zeta2 it's the
	// editable region between <<<<<<< CURRENT and =======.
	windowStartLine: number;
	windowEndLine: number;
	// Full file lines + byte offsets. The response parser indexes into these
	// to produce a UTF-8 byte-offset edit. These reflect the *undecorated*
	// document; if injectInlineDiagnostics added FIXME suffixes, those live
	// in the rendered prompt only and are stripped from the response via
	// injectedFixmeMessages.
	lines: PromptLine[];
	cursorLineByteOffsets: number[];
	// Diagnostic messages whose inline `<commentPrefix> <marker>` form
	// was injected into the rendered prompt. Non-empty signals the
	// response parser to run the strip; the array's contents are
	// retained for diagnostics/debug logging.
	injectedFixmeMessages?: string[];
	// Comment prefix used to wrap the injected FIXMEs ("//", "#", "--").
	// Combined with inlineDiagnosticsMarker to form the strip anchor.
	commentPrefix?: string;
	// Marker phrase between the comment prefix and the diagnostic
	// body — e.g. "BUG: LSP error here". The literal substring
	// `<commentPrefix> <marker>` is the strip anchor, so this must
	// match what the prompt builder emitted.
	inlineDiagnosticsMarker?: string;
}

export function detectModelFormat(modelName: string): ModelFormat {
	const lower = modelName.toLowerCase();
	if (
		lower.includes("zeta-2") ||
		lower.includes("zeta2") ||
		lower.includes("seedcoder") ||
		lower.includes("seed-coder") ||
		lower.includes("zed-industries/zeta")
	) {
		return "zeta2";
	}
	return "sweep";
}
