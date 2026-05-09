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
	// to produce a UTF-8 byte-offset edit.
	lines: PromptLine[];
	cursorLineByteOffsets: number[];
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
