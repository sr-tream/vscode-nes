// Sweep next-edit prompt builder. Ported from cursortab's
// server/provider/sweep/sweep.go so we can talk to Ollama directly without
// the Python uvx server in between.
//
// Prompt layout (single completion text fed to /v1/completions). Section
// order is tuned for prefix-cache friendliness: rules (session-stable)
// first, then sections that vary per cursor move / keystroke / LSP update,
// with diagnostics last so the model sees them adjacent to the edit
// window.
//
//   <|file_sep|>context/rules                NESweep extension; cache-stable
//   {rules body}
//
//   <|file_sep|>context/retrieval            other open buffers + LSP results
//   <|file_sep|>{snapshot.path}
//   {snapshot body}
//   ...
//
//   <|file_sep|>{path}.diff                  diff history, if any
//   original:
//   {old}
//   updated:
//   {new}
//
//   <|file_sep|>context/diagnostics          omitted if no diagnostics
//   Line N: [source] message
//
//   <|file_sep|>{path}                       broad file context (~300 lines)
//   {file body around cursor}
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

import type { MessageTransform } from "~/core/config.ts";
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
	// Lines to keep before / after cursor in the <|file_sep|>{path}
	// broad-context section. Cursortab hardcodes ±150 in its provider, but
	// the section is informational only — the original/current/updated edit
	// window is independent — so trimming here only reduces token pressure.
	broadBefore: number;
	broadAfter: number;
	// Drop diagnostics whose line is more than this many lines from the
	// cursor. 0 = no filter (keep all). cursortab forwards every LSP
	// diagnostic on the file, which on chatty linters dominates the prompt.
	diagRadius: number;
	// Already-comment-formatted rules block, emitted as a stable sibling
	// section before the volatile prompt context. Empty string disables.
	rules: string;
	// Single-line comment prefix for the document's language ("//", "#",
	// "--"). Used to format diagnostics as familiar TODO/FIXME comments
	// the model has seen in training data instead of the bare
	// `Line N: [severity] message` style upstream cursortab uses.
	commentPrefix: string;
	// Recommended for the small SweepAI checkpoints (0.5B and 1.5B) that
	// ignore the structured diagnostics section. The 7B SweepAI default
	// and the 8B Zeta2 SeedCoder don't need this. When true, append
	// `<commentPrefix> <inlineDiagnosticsMarker> (code: <code>) -
	// <message>` to every line within diagRadius that has an LSP
	// diagnostic, in the rendered prompt only. Post-response strip
	// anchors on the literal `<commentPrefix> <marker>` substring.
	injectInlineDiagnostics: boolean;
	// Marker phrase emitted between the comment prefix and the
	// diagnostic body. Default `BUG: LSP error here` — should be a
	// phrase a human would essentially never write so the strip can
	// pinpoint our injections.
	inlineDiagnosticsMarker: string;
	// Additional regex transforms applied to each diagnostic message
	// AFTER the built-in normalisations. Each entry is
	// `{ pattern, replacement, flags? }` (JS regex; replacement may
	// reference $1/$2 capture groups).
	messageTransforms: MessageTransform[];
}

const DEFAULT_OPTIONS: SweepPromptOptions = {
	broadBefore: 125,
	broadAfter: 75,
	diagRadius: 12,
	rules: "",
	commentPrefix: "//",
	injectInlineDiagnostics: false,
	inlineDiagnosticsMarker: "BUG: LSP error here",
	messageTransforms: [],
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

	// `lines` (and lineOffsets) reflect the actual document — the response
	// builder uses them to map model output back to byte offsets, so they
	// must NOT pick up FIXME suffixes. `promptLines` carries the rendered
	// view: identical to lines unless inline injection is enabled.
	const { promptLines, injectedFixmeMessages } = decorateLinesWithFixmes(
		lines,
		req.editor_diagnostics,
		cursorLine,
		opts,
	);

	let body = "";

	// Rules go first so they form a cache-stable prompt prefix: they only
	// change when the user edits .vscode/nes-{lang}.md, while every section
	// after this varies per cursor move / keystroke / LSP update. Putting
	// them ahead of the broad context maximises prefix-cache hits across
	// requests. Splicing them INSIDE the broad-context section would still
	// let the model treat them as code drift to "fix" (breaking the
	// line-diff), but a leading sibling section is clearly named.
	if (opts.rules !== "") {
		body += `<|file_sep|>context/rules\n${opts.rules}`;
		if (!opts.rules.endsWith("\n")) body += "\n";
	}

	const broad = buildBroadContext(
		promptLines,
		cursorLine,
		opts.broadBefore,
		opts.broadAfter,
	);
	const broadSection =
		broad === "" ? "" : `<|file_sep|>${req.file_path}\n${broad}\n`;
	const retrieval = formatRetrievalSection(
		req.file_chunks,
		req.retrieval_chunks,
	);
	if (retrieval !== "") body += retrieval;

	const diffSection = formatDiffSection(req.recent_changes);
	if (diffSection !== "") body += diffSection;

	// Diagnostics last among context sections — sits immediately before the
	// original/current/updated triplet so the model attends to the latest
	// LSP errors when generating the edit. Models routinely ignore
	// diagnostics buried earlier in a long prompt. Skipped when inline
	// injection is on: the per-line `BUG:` comments already surface the
	// same diagnostics, so emitting the structured block too would
	// duplicate the data and bloat the prompt.
	if (!opts.injectInlineDiagnostics) {
		const diagnostics = formatDiagnosticsSection(
			req.editor_diagnostics,
			cursorLine + 1, // diagnostic lines in the schema are 1-indexed
			opts.diagRadius,
			opts.commentPrefix,
			lines,
			lineOffsets,
			opts.messageTransforms,
		);
		if (diagnostics !== "") body += diagnostics;
	}

	body += broadSection;

	const windowText = promptLines
		.slice(windowStartLine, windowEndLine)
		.join("\n");
	const startLine1 = windowStartLine + 1;
	const endLine1 = windowEndLine;

	const relativeCursor = relativeCursorByte(
		promptLines,
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
		// Sweep is single-region; the primary region matches the
		// full original/current/updated window.
		regions: [
			{
				startLine: windowStartLine,
				endLine: windowEndLine,
				isPrimary: true,
			},
		],
		lines: lines.map((content, i) => ({
			startByte: lineOffsets[i] ?? 0,
			content,
		})),
		cursorLineByteOffsets: lineOffsets,
		...(injectedFixmeMessages.length > 0
			? {
					injectedFixmeMessages,
					commentPrefix: opts.commentPrefix,
					inlineDiagnosticsMarker: opts.inlineDiagnosticsMarker,
				}
			: {}),
	};
}

// Append `<commentPrefix> FIXME: <message>` to lines that have a
// diagnostic within `diagRadius` of the cursor. Returns a new lines
// array; the caller keeps the original `lines` for response mapping.
function decorateLinesWithFixmes(
	lines: string[],
	diagnostics: EditorDiagnostic[],
	cursorLine: number,
	opts: SweepPromptOptions,
): { promptLines: string[]; injectedFixmeMessages: string[] } {
	if (!opts.injectInlineDiagnostics || diagnostics.length === 0) {
		return { promptLines: lines, injectedFixmeMessages: [] };
	}
	const cursorLine1 = cursorLine + 1;
	// Emit shape: `<commentPrefix> <marker> (code: <code>) - <message>`.
	// The default marker is `BUG: LSP error here`; users can override
	// via the `sweep.inlineDiagnosticsMarker` setting if a different
	// phrasing happens to attend better on their model.
	type Entry = { message: string; code: string | undefined };
	const byLine = new Map<number, Entry[]>();
	for (const d of diagnostics) {
		if (
			opts.diagRadius > 0 &&
			Math.abs(d.line - cursorLine1) > opts.diagRadius
		) {
			continue;
		}
		const arr = byLine.get(d.line - 1) ?? [];
		arr.push({
			message: normalizeDiagnosticMessage(d.message, opts.messageTransforms),
			code: d.code,
		});
		byLine.set(d.line - 1, arr);
	}
	if (byLine.size === 0) {
		return { promptLines: lines, injectedFixmeMessages: [] };
	}
	const messages: string[] = [];
	const promptLines = lines.map((line, i) => {
		const entries = byLine.get(i);
		if (!entries) return line;
		const joinedMsg = entries.map((e) => e.message).join(" / ");
		const codes = entries
			.map((e) => e.code)
			.filter((c): c is string => Boolean(c));
		const codePart = codes.length > 0 ? ` (code: ${codes.join(",")})` : "";
		messages.push(joinedMsg);
		return `${line} ${opts.commentPrefix} ${opts.inlineDiagnosticsMarker}${codePart} - ${joinedMsg}`;
	});
	return { promptLines, injectedFixmeMessages: messages };
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
	commentPrefix: string,
	lines: string[],
	lineOffsets: number[],
	messageTransforms: MessageTransform[],
): string {
	if (diagnostics.length === 0) return "";
	const filtered =
		radius > 0
			? diagnostics.filter((d) => Math.abs(d.line - cursorLine1) <= radius)
			: diagnostics;
	if (filtered.length === 0) return "";
	const body = renderDiagnosticsAsComments(
		filtered,
		commentPrefix,
		lines,
		lineOffsets,
		messageTransforms,
	);
	return `<|file_sep|>context/diagnostics\n${body}`;
}

// Render diagnostics as a comment block in the document's language. Each
// diagnostic produces a gcc/clang-style "[severity] line N:col: message"
// header followed by the offending source line trimmed of indentation.
// The model has seen this pattern in compiler output during pretraining,
// so wrapping it in the file's comment syntax (so it reads as a TODO
// block in the code) measurably increases attention to the diagnostic
// when generating the edit.
export function renderDiagnosticsAsComments(
	diagnostics: EditorDiagnostic[],
	commentPrefix: string,
	lines: string[],
	lineOffsets: number[],
	messageTransforms: MessageTransform[] = [],
): string {
	let out = `${commentPrefix} FIXME: Fix these issues:\n`;
	for (const d of diagnostics) {
		const lineIdx = d.line - 1;
		const lineStart = lineOffsets[lineIdx] ?? 0;
		const col =
			d.start_offset >= lineStart ? d.start_offset - lineStart + 1 : 1;
		const msg = normalizeDiagnosticMessage(d.message, messageTransforms);
		out += `${commentPrefix} [${d.severity}] line ${d.line}:${col}: ${msg}\n`;
		const source = (lines[lineIdx] ?? "").trim();
		if (source !== "") out += `${commentPrefix}   ${source}\n`;
	}
	return out;
}

// Rephrase LSP diagnostic messages into a more directive form so a small
// model is more likely to act on them:
//
//   * "...; did you mean 'X'?"     →  "use 'X' instead (...)"
//   * "(fix available)" suffix     →  stripped (IDE-internal noise)
//   * "...; consider using 'X'"    →  "use 'X' instead (...)"
//
// User-supplied regex transforms are applied AFTER these built-ins so a
// project can patch in linter-specific phrasings without losing the
// defaults. Non-destructive on no-match: original description survives
// in parens so the model still has the context.
export function normalizeDiagnosticMessage(
	message: string,
	userTransforms: MessageTransform[] = [],
): string {
	let msg = message.trim();
	// clangd / TS append "(fix available)" / "(fixes available)" when a
	// quickfix exists. The model has no IDE to invoke; the suffix only
	// telegraphs "ignore me, the IDE will handle it".
	msg = msg.replace(/\s*\((?:fix|fixes) available\)\s*$/i, "").trim();

	// Common directive-extraction patterns from clang/TypeScript/Rust.
	// Each capture group #1 is the rest of the description, #2 is the
	// suggested replacement.
	const patterns = [
		/^(.*?)[;,]?\s*did you mean ['"`]([^'"`]+)['"`]\??\s*$/i,
		/^(.*?)[;,]?\s*consider using ['"`]([^'"`]+)['"`]\.?\s*$/i,
		/^(.*?)[;,]?\s*replace with ['"`]([^'"`]+)['"`]\.?\s*$/i,
	];
	for (const re of patterns) {
		const m = msg.match(re);
		if (m) {
			const rest = (m[1] ?? "").trim().replace(/[;,.]+$/, "");
			const suggestion = m[2] ?? "";
			msg =
				rest === ""
					? `use '${suggestion}' instead`
					: `use '${suggestion}' instead (${rest})`;
			break;
		}
	}

	// Apply user-supplied transforms in declaration order. Invalid
	// regexes are skipped silently so a single bad config entry doesn't
	// break the whole pipeline.
	for (const t of userTransforms) {
		try {
			const re = new RegExp(t.pattern, t.flags);
			msg = msg.replace(re, t.replacement);
		} catch {
			// ignore malformed pattern
		}
	}

	return msg;
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
