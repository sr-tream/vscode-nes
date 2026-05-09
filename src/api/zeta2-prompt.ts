// Zeta2 (Zed's SeedCoder-8B edit-prediction model) prompt builder. Ported
// from cursortab.nvim's server/provider/zeta2/zeta2.go. The model is
// distributed as `zed-industries/zeta2` on Hugging Face and uses the
// SeedCoder SPM Fill-In-Middle layout, not the sweep <|file_sep|> layout.
//
// Prompt layout (single completion text fed to /v1/completions). Pseudo-
// files inside the prefix block are ordered for prefix-cache friendliness:
// rules first (session-stable), then volatile context, with diagnostics
// last so the model sees them adjacent to the cursor file's CURRENT block.
//
//   <[fim-suffix]>{code after editable region}\n
//
//   <[fim-prefix]><filename>context/rules     (omitted if no rules)
//   {rules body}
//
//   <filename>{path}                          (recent buffer pseudo-files)
//   {file body}
//
//   <filename>edit_history                    (omitted if no recent changes)
//   --- a/{path}
//   +++ b/{path}
//   {unified diff}
//
//   <filename>diagnostics                     (omitted if no diagnostics)
//   line N: [severity] message
//
//   <filename>{cursor file path}
//   {code before editable region}
//   <<<<<<< CURRENT
//   {editable region with <|user_cursor|> inline}
//   =======
//   <[fim-middle]>
//
// The model emits the replacement editable region terminated by
// ">>>>>>> UPDATED". A literal "NO_EDITS" output means no change.

import type { MessageTransform } from "~/core/config.ts";
import type { ModelPrompt } from "./model-format.ts";
import type {
	AutocompleteRequest,
	EditorDiagnostic,
	FileChunk,
} from "./schemas.ts";
import {
	computeLineByteOffsets,
	locateCursor,
	normalizeDiagnosticMessage,
	renderDiagnosticsAsComments,
	splitLines,
} from "./sweep-prompt.ts";

export const ZETA2_STOP_TOKENS = [">>>>>>> UPDATED\n", ">>>>>>> UPDATED"];

const FIM_SUFFIX = "<[fim-suffix]>";
const FIM_PREFIX = "<[fim-prefix]>";
const FIM_MIDDLE = "<[fim-middle]>";
const FILE_MARKER = "<filename>";
export const ZETA2_CURRENT_MARKER = "<<<<<<< CURRENT\n";
export const ZETA2_SEPARATOR = "=======\n";
export const ZETA2_END_MARKER = ">>>>>>> UPDATED\n";
export const ZETA2_NO_EDITS = "NO_EDITS";
export const ZETA2_CURSOR_MARKER = "<|user_cursor|>";

// Zed's cloud Zeta2 endpoint targets ±350 / ±150 token budgets for the
// editable / context regions. We approximate with line counts since we
// don't carry a tokenizer; the model is robust enough that ±15 lines
// around the cursor lands within the trained budget.
const EDITABLE_LINES_BEFORE = 15;
const EDITABLE_LINES_AFTER = 15;

const MAX_DIAGNOSTICS = 15;

export interface Zeta2PromptOptions {
	diagRadius: number;
	rules: string;
	// Single-line comment prefix for the document's language. See sweep-
	// prompt.ts SweepPromptOptions.commentPrefix for rationale.
	commentPrefix: string;
	// Mega-hack toggle. See sweep-prompt's SweepPromptOptions field of
	// the same name.
	injectInlineDiagnostics: boolean;
	// Marker phrase between comment prefix and diagnostic body. See
	// SweepPromptOptions.inlineDiagnosticsMarker.
	inlineDiagnosticsMarker: string;
	// User-supplied regex transforms applied after built-in diagnostic
	// normalisations. See SweepPromptOptions.messageTransforms.
	messageTransforms: MessageTransform[];
}

const DEFAULT_OPTIONS: Zeta2PromptOptions = {
	diagRadius: 12,
	rules: "",
	commentPrefix: "//",
	injectInlineDiagnostics: false,
	inlineDiagnosticsMarker: "BUG: LSP error here",
	messageTransforms: [],
};

export function buildZeta2Prompt(
	req: AutocompleteRequest,
	overrides: Partial<Zeta2PromptOptions> = {},
): ModelPrompt {
	const opts: Zeta2PromptOptions = { ...DEFAULT_OPTIONS, ...overrides };
	const lines = splitLines(req.file_contents);
	const lineOffsets = computeLineByteOffsets(lines);

	const { line: cursorLine, col: cursorCol } = locateCursor(
		lineOffsets,
		req.cursor_position,
	);

	const editableStart = Math.max(0, cursorLine - EDITABLE_LINES_BEFORE);
	const editableEnd = Math.min(
		lines.length,
		cursorLine + EDITABLE_LINES_AFTER + 1,
	);

	// `lines` reflects the actual document and is preserved on prompt.lines
	// for response mapping. `promptLines` is the rendered view that may
	// carry inline FIXME suffixes; the response builder strips those via
	// injectedFixmeMessages before line-diffing.
	const { promptLines, injectedFixmeMessages } = decorateLinesWithFixmes(
		lines,
		req.editor_diagnostics,
		cursorLine,
		opts,
	);

	const beforeLines = promptLines.slice(0, editableStart);
	const editLines = promptLines.slice(editableStart, editableEnd);
	const suffixLines = promptLines.slice(editableEnd);

	let body = "";

	// Suffix section: <[fim-suffix]>{code after editable region}\n
	body += FIM_SUFFIX;
	const suffixText = suffixLines.join("\n");
	body += suffixText;
	body += suffixText.endsWith("\n") || suffixText === "" ? "" : "\n";
	if (suffixText === "") body += "\n";

	// Prefix section: <[fim-prefix]>{rules}{recent files}{edit_history}{diagnostics}{cursor file}
	body += FIM_PREFIX;

	// Workspace rules pseudo-file first inside the prefix block. Rules
	// are session-stable (only change when the user edits
	// .vscode/nes-{lang}.md) while every later pseudo-file is volatile,
	// so this maximises prefix-cache reuse across requests. NESweep
	// extension — cursortab's zeta2 has no equivalent slot.
	if (opts.rules !== "") {
		body += `${FILE_MARKER}context/rules\n${opts.rules}`;
		if (!opts.rules.endsWith("\n")) body += "\n";
		body += "\n";
	}

	// Recent buffers as pseudo-files. Cursortab fills this slot with
	// LSP-related files; we use file_chunks (visible editors + recent
	// buffers) as the closest proxy.
	body += formatRecentFilesPseudoFiles(req.file_chunks);

	// Edit history pseudo-file. The upstream emits a git-style unified
	// diff per event; our recent_changes string is already pre-formatted
	// per file with `File: {path}:` headers (see formatRecentChanges in
	// client.ts), so we emit it verbatim — the model is tolerant enough
	// to read it.
	const editHistory = req.recent_changes.trim();
	if (editHistory !== "") {
		body += `${FILE_MARKER}edit_history\n${editHistory}\n\n`;
	}

	// Diagnostics last among context pseudo-files — sits immediately
	// before the cursor file with its CURRENT/UPDATED markers, so the
	// model attends to the latest LSP errors when generating the edit.
	// Skipped when inline injection is on: the per-line `BUG:` comments
	// in the cursor file already surface the same diagnostics, so the
	// structured pseudo-file would just duplicate the data.
	if (!opts.injectInlineDiagnostics) {
		body += formatDiagnosticsPseudoFile(
			req.editor_diagnostics,
			cursorLine + 1,
			opts.diagRadius,
			opts.commentPrefix,
			lines,
			lineOffsets,
			opts.messageTransforms,
		);
	}

	// Cursor file section
	body += `${FILE_MARKER}${req.file_path}\n`;

	if (beforeLines.length > 0) {
		body += `${beforeLines.join("\n")}\n`;
	}

	body += ZETA2_CURRENT_MARKER;
	const editableText = formatEditableWithCursor(
		editLines,
		cursorLine - editableStart,
		cursorCol,
	);
	body += editableText;
	if (!editableText.endsWith("\n")) body += "\n";
	body += ZETA2_SEPARATOR;
	body += FIM_MIDDLE;

	return {
		prompt: body,
		// FIM has no prefill — the model continues directly after <[fim-middle]>.
		prefill: "",
		format: "zeta2",
		stopTokens: ZETA2_STOP_TOKENS,
		windowStartLine: editableStart,
		windowEndLine: editableEnd,
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

function decorateLinesWithFixmes(
	lines: string[],
	diagnostics: EditorDiagnostic[],
	cursorLine: number,
	opts: Zeta2PromptOptions,
): { promptLines: string[]; injectedFixmeMessages: string[] } {
	if (!opts.injectInlineDiagnostics || diagnostics.length === 0) {
		return { promptLines: lines, injectedFixmeMessages: [] };
	}
	const cursorLine1 = cursorLine + 1;
	// See sweep-prompt.ts decorateLinesWithFixmes for the format / strip
	// anchor rationale.
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

function formatEditableWithCursor(
	editLines: string[],
	cursorRelLine: number,
	cursorCol: number,
): string {
	if (editLines.length === 0) return ZETA2_CURSOR_MARKER;
	let relLine = cursorRelLine;
	if (relLine < 0) relLine = 0;
	if (relLine >= editLines.length) relLine = editLines.length - 1;

	const out = editLines.slice();
	const line = out[relLine] ?? "";
	let col = cursorCol;
	if (col > line.length) col = line.length;
	if (col < 0) col = 0;
	out[relLine] = line.slice(0, col) + ZETA2_CURSOR_MARKER + line.slice(col);
	return out.join("\n");
}

function formatRecentFilesPseudoFiles(chunks: FileChunk[]): string {
	let out = "";
	for (const chunk of chunks) {
		if (chunk.content.trim() === "") continue;
		out += `${FILE_MARKER}${chunk.file_path}\n${chunk.content}`;
		if (!chunk.content.endsWith("\n")) out += "\n";
		out += "\n";
	}
	return out;
}

function formatDiagnosticsPseudoFile(
	diagnostics: EditorDiagnostic[],
	cursorLine1: number,
	diagRadius: number,
	commentPrefix: string,
	lines: string[],
	lineOffsets: number[],
	messageTransforms: MessageTransform[],
): string {
	if (diagnostics.length === 0) return "";

	const filtered =
		diagRadius > 0
			? diagnostics.filter((d) => Math.abs(d.line - cursorLine1) <= diagRadius)
			: diagnostics;
	if (filtered.length === 0) return "";

	const limited = filtered.slice(0, MAX_DIAGNOSTICS);
	const body = renderDiagnosticsAsComments(
		limited,
		commentPrefix,
		lines,
		lineOffsets,
		messageTransforms,
	);
	return `${FILE_MARKER}diagnostics\n${body}\n`;
}
