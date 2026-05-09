// Zeta2 (Zed's SeedCoder-8B edit-prediction model) prompt builder. Ported
// from cursortab.nvim's server/provider/zeta2/zeta2.go. The model is
// distributed as `zed-industries/zeta2` on Hugging Face and uses the
// SeedCoder SPM Fill-In-Middle layout, not the sweep <|file_sep|> layout.
//
// Prompt layout (single completion text fed to /v1/completions):
//
//   <[fim-suffix]>{code after editable region}\n
//   <[fim-prefix]><filename>{path}            (recent buffer pseudo-files)
//   {file body}
//
//   <filename>diagnostics                     (omitted if no diagnostics)
//   line N: [severity] message
//
//   <filename>edit_history                    (omitted if no recent changes)
//   --- a/{path}
//   +++ b/{path}
//   {unified diff}
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

import type { ModelPrompt } from "./model-format.ts";
import type {
	AutocompleteRequest,
	EditorDiagnostic,
	FileChunk,
} from "./schemas.ts";
import {
	computeLineByteOffsets,
	locateCursor,
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
}

const DEFAULT_OPTIONS: Zeta2PromptOptions = {
	diagRadius: 12,
	rules: "",
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

	const beforeLines = lines.slice(0, editableStart);
	const editLines = lines.slice(editableStart, editableEnd);
	const suffixLines = lines.slice(editableEnd);

	let body = "";

	// Suffix section: <[fim-suffix]>{code after editable region}\n
	body += FIM_SUFFIX;
	const suffixText = suffixLines.join("\n");
	body += suffixText;
	body += suffixText.endsWith("\n") || suffixText === "" ? "" : "\n";
	if (suffixText === "") body += "\n";

	// Prefix section: <[fim-prefix]>{context pseudo-files}{edit_history}{cursor file}
	body += FIM_PREFIX;

	// Recent buffers as pseudo-files. Cursortab fills this slot with
	// LSP-related files; we use file_chunks (visible editors + recent
	// buffers) as the closest proxy.
	body += formatRecentFilesPseudoFiles(req.file_chunks);

	// Diagnostics pseudo-file
	body += formatDiagnosticsPseudoFile(
		req.editor_diagnostics,
		cursorLine + 1,
		opts.diagRadius,
	);

	// Workspace rules pseudo-file (NESweep extension — cursortab's zeta2
	// has no equivalent slot; we emit it as a sibling pseudo-file so the
	// model sees it ahead of the edit history.)
	if (opts.rules !== "") {
		body += `${FILE_MARKER}context/rules\n${opts.rules}`;
		if (!opts.rules.endsWith("\n")) body += "\n";
		body += "\n";
	}

	// Edit history pseudo-file. The upstream emits a git-style unified
	// diff per event; our recent_changes string is already pre-formatted
	// per file with `File: {path}:` headers (see formatRecentChanges in
	// client.ts), so we emit it verbatim — the model is tolerant enough
	// to read it.
	const editHistory = req.recent_changes.trim();
	if (editHistory !== "") {
		body += `${FILE_MARKER}edit_history\n${editHistory}\n\n`;
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
	};
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
): string {
	if (diagnostics.length === 0) return "";

	const filtered =
		diagRadius > 0
			? diagnostics.filter((d) => Math.abs(d.line - cursorLine1) <= diagRadius)
			: diagnostics;
	if (filtered.length === 0) return "";

	const limited = filtered.slice(0, MAX_DIAGNOSTICS);
	let body = "";
	for (const d of limited) {
		body += `line ${d.line}: [${d.severity}] ${d.message}\n`;
	}
	return `${FILE_MARKER}diagnostics\n${body}\n`;
}
