// Sweep next-edit prompt builder. Ported from cursortab's
// server/provider/sweep/sweep.go so we can talk to Ollama directly without
// the Python uvx server in between.
//
// Prompt layout (single completion text fed to /v1/completions):
//
//   <|file_sep|>{path}                       broad file context (~300 lines)
//   {file body around cursor}
//
//   <|file_sep|>context/retrieval            other open buffers + LSP results
//   <|file_sep|>{snapshot.path}
//   {snapshot body}
//   ...
//
//   <|file_sep|>context/diagnostics          omitted if no diagnostics
//   Line N: [source] message
//
//   <|file_sep|>{path}.diff                  diff history, if any
//   original:
//   {old}
//   updated:
//   {new}
//
//   <|file_sep|>original/{path}:N:M          edit window, no marker
//   {window lines}
//
//   <|file_sep|>current/{path}:N:M           edit window with cursor
//   {window before cursor}<|cursor|>{window after cursor}
//
//   <|file_sep|>updated/{path}:N:M           prefilled, model continues
//   {prefill}
//
// Stop tokens: <|file_sep|>, <|endoftext|>.

import type { ModelPrompt } from "./model-format.ts";
import type {
	AutocompleteRequest,
	EditorDiagnostic,
	FileChunk,
	UserAction,
} from "./schemas.ts";

export const SWEEP_STOP_TOKENS = ["<|file_sep|>", "<|endoftext|>"];

const WINDOW_LINES_BEFORE = 30;
const WINDOW_LINES_AFTER = 30;

export interface SweepPromptOptions {
	// Lines to keep before / after cursor in the leading <|file_sep|>{path}
	// broad-context section. Cursortab hardcodes ±150 in its provider, but
	// the section is informational only — the original/current/updated edit
	// window is independent — so trimming here only reduces token pressure.
	broadBefore: number;
	broadAfter: number;
	// Drop diagnostics whose line is more than this many lines from the
	// cursor. 0 = no filter (keep all). cursortab forwards every LSP
	// diagnostic on the file, which on chatty linters dominates the prompt.
	diagRadius: number;
	// Already-comment-formatted rules block, spliced in immediately after
	// the leading <|file_sep|>{path} header (i.e. as a top-of-file comment
	// from the model's perspective). Empty string disables.
	rules: string;
}

const DEFAULT_OPTIONS: SweepPromptOptions = {
	broadBefore: 125,
	broadAfter: 75,
	diagRadius: 12,
	rules: "",
};

export function buildSweepPrompt(
	req: AutocompleteRequest,
	overrides: Partial<SweepPromptOptions> = {},
): ModelPrompt {
	const opts: SweepPromptOptions = { ...DEFAULT_OPTIONS, ...overrides };
	const lines = splitLines(req.file_contents);
	const lineOffsets = computeLineByteOffsets(lines);

	const { line: cursorLine, col: cursorCol } = locateCursor(
		lineOffsets,
		req.cursor_position,
	);

	const windowStartLine = Math.max(0, cursorLine - WINDOW_LINES_BEFORE);
	const windowEndLine = Math.min(
		lines.length,
		cursorLine + WINDOW_LINES_AFTER + 1,
	);

	let body = "";

	const broad = buildBroadContext(
		lines,
		cursorLine,
		opts.broadBefore,
		opts.broadAfter,
	);
	if (broad !== "") {
		body += `<|file_sep|>${req.file_path}\n${broad}\n`;
	}

	const retrieval = formatRetrievalSection(
		req.file_chunks,
		req.retrieval_chunks,
	);
	if (retrieval !== "") body += retrieval;

	const diagnostics = formatDiagnosticsSection(
		req.editor_diagnostics,
		cursorLine + 1, // diagnostic lines in the schema are 1-indexed
		opts.diagRadius,
	);
	if (diagnostics !== "") body += diagnostics;

	const diffSection = formatDiffSection(req.recent_changes);
	if (diffSection !== "") body += diffSection;

	// Rules are emitted as a sibling context section right before the
	// original/current/updated triplet, alongside the existing
	// context/retrieval and context/diagnostics siblings. Splicing into
	// the broad-context section above would let the model see them as
	// part of the file body and treat the difference vs. the pristine
	// code in the edit window as drift to "fix", breaking the line-diff.
	if (opts.rules !== "") {
		body += `<|file_sep|>context/rules\n${opts.rules}`;
	}

	const windowText = lines.slice(windowStartLine, windowEndLine).join("\n");
	const startLine1 = windowStartLine + 1;
	const endLine1 = windowEndLine;

	const relativeCursor = relativeCursorByte(
		lines,
		windowStartLine,
		cursorLine,
		cursorCol,
	);
	const clampedCursor = Math.min(relativeCursor, windowText.length);
	const windowWithCursor =
		windowText.slice(0, clampedCursor) +
		"<|cursor|>" +
		windowText.slice(clampedCursor);

	body += `<|file_sep|>original/${req.file_path}:${startLine1}:${endLine1}\n${windowText}\n`;
	body += `<|file_sep|>current/${req.file_path}:${startLine1}:${endLine1}\n${windowWithCursor}\n`;
	body += `<|file_sep|>updated/${req.file_path}:${startLine1}:${endLine1}\n`;

	const prefill = computePrefill(
		windowText,
		clampedCursor,
		hasRecentInsertionAboveCursor(
			req.recent_user_actions,
			cursorLine,
			windowStartLine,
		),
	);
	body += prefill;

	return {
		prompt: body,
		prefill,
		format: "sweep",
		stopTokens: SWEEP_STOP_TOKENS,
		windowStartLine,
		windowEndLine,
		lines: lines.map((content, i) => ({
			startByte: lineOffsets[i] ?? 0,
			content,
		})),
		cursorLineByteOffsets: lineOffsets,
	};
}

export function splitLines(text: string): string[] {
	return text.split("\n");
}

export function computeLineByteOffsets(lines: string[]): number[] {
	const offsets = new Array<number>(lines.length + 1);
	offsets[0] = 0;
	let off = 0;
	for (let i = 0; i < lines.length; i++) {
		const lineStr = lines[i] ?? "";
		off += Buffer.byteLength(lineStr, "utf8") + 1; // +1 for '\n'
		offsets[i + 1] = off;
	}
	return offsets;
}

export function locateCursor(
	lineOffsets: number[],
	cursorByte: number,
): { line: number; col: number } {
	if (cursorByte <= 0) return { line: 0, col: 0 };
	for (let i = 0; i < lineOffsets.length - 1; i++) {
		const start = lineOffsets[i] ?? 0;
		const next = lineOffsets[i + 1] ?? start;
		// Cursor at the trailing '\n' of line i is treated as col=lineLen.
		if (cursorByte < next) {
			return { line: i, col: cursorByte - start };
		}
	}
	const last = Math.max(0, lineOffsets.length - 2);
	const start = lineOffsets[last] ?? 0;
	return { line: last, col: cursorByte - start };
}

function relativeCursorByte(
	lines: string[],
	windowStart: number,
	cursorLine: number,
	cursorCol: number,
): number {
	let off = 0;
	for (let i = windowStart; i < cursorLine; i++) {
		off += Buffer.byteLength(lines[i] ?? "", "utf8") + 1;
	}
	return off + cursorCol;
}

function buildBroadContext(
	lines: string[],
	cursorLine: number,
	before: number,
	after: number,
): string {
	if (lines.length === 0) return "";
	if (before <= 0 && after <= 0) return "";
	const start = Math.max(0, cursorLine - before);
	const end = Math.min(lines.length, cursorLine + after + 1);
	return lines.slice(start, end).join("\n");
}

function formatRetrievalSection(
	fileChunks: FileChunk[],
	retrievalChunks: FileChunk[],
): string {
	const all = [...fileChunks, ...retrievalChunks];
	if (all.length === 0) return "";
	let out = "<|file_sep|>context/retrieval\n";
	for (const chunk of all) {
		out += `<|file_sep|>${chunk.file_path}\n${chunk.content}\n`;
	}
	return out;
}

function formatDiagnosticsSection(
	diagnostics: EditorDiagnostic[],
	cursorLine1: number,
	radius: number,
): string {
	if (diagnostics.length === 0) return "";
	const filtered =
		radius > 0
			? diagnostics.filter((d) => Math.abs(d.line - cursorLine1) <= radius)
			: diagnostics;
	if (filtered.length === 0) return "";
	let out = "<|file_sep|>context/diagnostics\n";
	for (const d of filtered) {
		out += `Line ${d.line}: [${d.severity}] ${d.message}\n`;
	}
	return out;
}

function formatDiffSection(recentChanges: string): string {
	const trimmed = recentChanges.trim();
	if (trimmed === "") return "";
	// Mirror cursortab's FormatDiffHistoryOriginalUpdated header style; the
	// vscode-nes upstream gives us a single pre-formatted string, so we just
	// wrap it in a section header keyed off the current file for the model.
	return `<|file_sep|>recent_changes\n${trimmed}\n`;
}

// computePrefill returns the suffix of the window text up to (and possibly
// including) the cursor line, depending on whether the user just inserted
// content above the cursor — in that case we leave the model freedom to
// rewrite the cursor line, otherwise we anchor the prefix exactly.
export function computePrefill(
	windowText: string,
	relativeCursor: number,
	changesAboveCursor: boolean,
): string {
	if (changesAboveCursor) {
		const prefix = windowText.slice(0, relativeCursor);
		const splitLines = prefix.split("\n");
		if (splitLines.length <= 1) return prefix;
		let result = `${splitLines[0]}\n`;
		const after = splitLines.slice(1).join("\n");
		for (const ch of after) {
			if (ch === "\n") {
				result += "\n";
			} else {
				break;
			}
		}
		return result;
	}

	const prefixBeforeCursor = windowText.slice(0, relativeCursor);
	const lastNl = prefixBeforeCursor.lastIndexOf("\n");
	if (lastNl < 0) return "";
	return windowText.slice(0, lastNl + 1);
}

function hasRecentInsertionAboveCursor(
	actions: UserAction[],
	cursorLine: number,
	windowStart: number,
): boolean {
	if (actions.length === 0) return false;
	const last = actions[actions.length - 1];
	if (!last) return false;
	if (
		last.action_type !== "INSERT_CHAR" &&
		last.action_type !== "INSERT_SELECTION"
	) {
		return false;
	}
	// UserAction.line_number is 1-indexed in the raw file; cursorLine is
	// 0-indexed in the file too. We compare both relative to windowStart so
	// "above cursor" matches the cursortab semantics.
	const lastInWindow = last.line_number - 1 - windowStart;
	const cursorInWindow = cursorLine - windowStart;
	return lastInWindow < cursorInWindow;
}
