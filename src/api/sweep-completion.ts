// Postprocessing for sweep model output. Mirrors the cleanup pipeline from
// cursortab's server/provider/{sweep,processors}.go: strip stop markers,
// reject empty/whitespace, kill repetition loops, then map the line-based
// rewrite back to a UTF-8 byte-offset edit on the user's document.
//
// Crucially, the model often re-emits a full window of code with only one
// or two lines changed. Whole-window replacement makes VSCode draw a giant
// ghost overlay even though most of it is identical to what's already
// there. We trim common-prefix and common-suffix lines so the returned
// edit covers only the lines that actually differ.

import { logger } from "~/core/logger.ts";
import type { CompletionResult } from "./completion-client.ts";
import type { ModelPrompt } from "./model-format.ts";
import type { AutocompleteResponse } from "./schemas.ts";
import { SWEEP_STOP_TOKENS } from "./sweep-prompt.ts";

export function buildSweepResponse(
	completion: CompletionResult,
	prompt: ModelPrompt,
	autocompleteId: string,
): AutocompleteResponse | null {
	// finish_reason=length means num_predict cut the model off mid-window.
	// Our line-diff post-processor trims by matching the new and old
	// window's leading + trailing identical lines, but a truncated response
	// has no trailing match — the diff ends up wanting to delete everything
	// from the truncation point through the original window's end, which is
	// destructive. Cursortab handles this with anchor-based truncation
	// (server/provider/processors.go AnchorTruncation); we don't, so the
	// only safe move is to drop the suggestion entirely.
	if (completion.finishReason === "length") return null;

	let text = completion.text;
	for (const marker of SWEEP_STOP_TOKENS) {
		const idx = text.indexOf(marker);
		if (idx !== -1) text = text.slice(0, idx);
	}
	// Replace the first cursor marker with a sentinel char so we can track
	// its position through prefill / repetition / line-trim mangling and
	// surface it as the snippet $0 location after accept. Any extra
	// markers are stripped without tracking.
	const markerCount = countCursorMarkers(text);
	if (markerCount > 0) {
		logger.debug(
			`sweep response contained ${markerCount} cursor marker(s); stripping`,
		);
	}
	text = injectCursorSentinel(text);
	text = text.replace(/[ \t\n\r]+$/g, "");
	if (text.replace(SENTINEL, "").trim() === "") return null;

	const fullText = prompt.prefill + text;
	const stripped = stripRepetition(fullText);
	if (stripped === null) return null;

	const newLines = stripped.split("\n");
	stripInjectedFixmesFromLines(
		newLines,
		prompt.injectedFixmeMessages,
		prompt.commentPrefix,
		prompt.inlineDiagnosticsMarker,
	);
	const oldLines = prompt.lines
		.slice(prompt.windowStartLine, prompt.windowEndLine)
		.map((l) => l.content);

	if (trimRight(newLines.join("\n")) === trimRight(oldLines.join("\n"))) {
		return null;
	}

	const trimmed = trimCommonEnds(oldLines, newLines);
	if (trimmed === null) return null;

	const { skipPrefix, oldMiddle, newMiddle } = trimmed;
	const startLineIdx = prompt.windowStartLine + skipPrefix;
	const endLineIdx = startLineIdx + oldMiddle.length; // exclusive

	const startByte = prompt.cursorLineByteOffsets[startLineIdx] ?? 0;
	let endByte: number;
	let completionText: string;

	if (oldMiddle.length === 0) {
		// Pure insertion — splice new lines in front of the suffix line. We
		// add a trailing newline so the completion forms its own line(s).
		endByte = startByte;
		completionText = `${newMiddle.join("\n")}\n`;
	} else if (newMiddle.length === 0) {
		// Pure deletion — gobble the trailing newline of the last removed
		// line by extending end_byte to the start of the next line.
		endByte = prompt.cursorLineByteOffsets[endLineIdx] ?? startByte;
		completionText = "";
	} else {
		const lastLineIdx = endLineIdx - 1;
		const lineStart = prompt.cursorLineByteOffsets[lastLineIdx] ?? startByte;
		const lineContent = prompt.lines[lastLineIdx]?.content ?? "";
		endByte = lineStart + Buffer.byteLength(lineContent, "utf8");
		completionText = newMiddle.join("\n");
	}

	const { text: cleanedCompletion, cursorTargetOffset } =
		extractCursorSentinel(completionText);
	completionText = cleanedCompletion;
	if (cursorTargetOffset !== undefined) {
		logger.debug(
			`sweep cursor target at offset ${cursorTargetOffset} of ${completionText.length}-char completion`,
		);
	}

	if (completionText.length === 0 && endByte === startByte) return null;

	return {
		autocomplete_id: autocompleteId,
		start_index: startByte,
		end_index: endByte,
		completion: completionText,
		confidence: 0.8,
		finish_reason: completion.finishReason,
		...(cursorTargetOffset !== undefined
			? { cursor_target_offset: cursorTargetOffset }
			: {}),
	};
}

interface TrimmedDiff {
	skipPrefix: number;
	oldMiddle: string[];
	newMiddle: string[];
}

// Strip leading and trailing lines that are identical between old and new
// so the reported edit covers only lines that actually changed. Returns
// null when the trim collapses the diff to nothing.
function trimCommonEnds(
	oldLines: string[],
	newLines: string[],
): TrimmedDiff | null {
	// splitLines on a file ending with '\n' produces a phantom trailing ""
	// that has no counterpart in the model output (text is right-trimmed),
	// so suffix-match would fail at the last comparison and the diff would
	// blow up to span the whole window. Drop trailing empties from both
	// sides before aligning.
	let oldEnd = oldLines.length;
	while (oldEnd > 0 && oldLines[oldEnd - 1] === "") oldEnd--;
	let newEnd = newLines.length;
	while (newEnd > 0 && newLines[newEnd - 1] === "") newEnd--;

	let skipPrefix = 0;
	const minLen = Math.min(oldEnd, newEnd);
	while (skipPrefix < minLen && oldLines[skipPrefix] === newLines[skipPrefix]) {
		skipPrefix++;
	}

	let skipSuffix = 0;
	const remainingOld = oldEnd - skipPrefix;
	const remainingNew = newEnd - skipPrefix;
	const maxSuffix = Math.min(remainingOld, remainingNew);
	while (
		skipSuffix < maxSuffix &&
		oldLines[oldEnd - 1 - skipSuffix] === newLines[newEnd - 1 - skipSuffix]
	) {
		skipSuffix++;
	}

	const oldMiddle = oldLines.slice(skipPrefix, oldEnd - skipSuffix);
	const newMiddle = newLines.slice(skipPrefix, newEnd - skipSuffix);
	if (oldMiddle.length === 0 && newMiddle.length === 0) return null;
	return { skipPrefix, oldMiddle, newMiddle };
}

function trimRight(s: string): string {
	return s.replace(/[ \t\n\r]+$/g, "");
}

// 3 consecutive identical non-empty lines means the model got stuck. Truncate
// just before the loop starts; if the very first lines repeat, the response
// is unsalvageable.
function stripRepetition(text: string): string | null {
	const lines = text.split("\n");
	let cutIdx = -1;
	for (let i = 2; i < lines.length; i++) {
		const a = lines[i];
		const b = lines[i - 1];
		const c = lines[i - 2];
		if (a === b && a === c && a !== undefined && a.trim() !== "") {
			cutIdx = i - 2;
			break;
		}
	}
	if (cutIdx < 0) return text;
	if (cutIdx === 0) return null;
	return lines.slice(0, cutIdx).join("\n");
}

// U+E000 (Private Use Area) — never appears in real source, so it survives
// line-splitting / repetition trimming / line-diff trimming intact.
const SENTINEL = String.fromCharCode(0xe000);
const PROMPT_MARKERS = ["<|user_cursor|>", "<|cursor|>"];

function countCursorMarkers(text: string): number {
	let n = 0;
	for (const m of PROMPT_MARKERS) {
		const parts = text.split(m).length - 1;
		n += parts;
	}
	return n;
}

// Replace the FIRST cursor marker with the sentinel so we can track it
// through downstream text mangling. Strip remaining occurrences silently.
function injectCursorSentinel(text: string): string {
	let firstIdx = -1;
	let firstLen = 0;
	for (const m of PROMPT_MARKERS) {
		const i = text.indexOf(m);
		if (i !== -1 && (firstIdx === -1 || i < firstIdx)) {
			firstIdx = i;
			firstLen = m.length;
		}
	}
	let result = text;
	if (firstIdx !== -1) {
		result =
			result.slice(0, firstIdx) + SENTINEL + result.slice(firstIdx + firstLen);
	}
	for (const m of PROMPT_MARKERS) {
		if (result.includes(m)) result = result.split(m).join("");
	}
	return result;
}

function extractCursorSentinel(text: string): {
	text: string;
	cursorTargetOffset: number | undefined;
} {
	const idx = text.indexOf(SENTINEL);
	if (idx === -1) return { text, cursorTargetOffset: undefined };
	const cleaned = text.slice(0, idx) + text.slice(idx + SENTINEL.length);
	return { text: cleaned, cursorTargetOffset: idx };
}

// Strip `<commentPrefix> <marker> …` suffixes the prompt builder
// injected via injectInlineDiagnostics, so the line-diff sees the
// model's output as if those comments had never been there. Mutates
// the array in place.
//
// We anchor on the literal substring `<commentPrefix> <marker>` (e.g.
// `// BUG: LSP error here`). The default marker is a phrase humans
// essentially never write, so matching it pinpoints our injection
// while leaving user-authored TODO/FIXME comments alone. Anchoring on
// a static phrase rather than message text is robust to small models
// paraphrasing the rest of the comment. No-op when no injection
// happened or the prompt didn't carry the marker.
export function stripInjectedFixmesFromLines(
	lines: string[],
	injectedFixmeMessages: string[] | undefined,
	commentPrefix: string | undefined,
	inlineDiagnosticsMarker: string | undefined,
): void {
	if (!injectedFixmeMessages || injectedFixmeMessages.length === 0) return;
	if (!commentPrefix || !inlineDiagnosticsMarker) return;
	const marker = `${commentPrefix} ${inlineDiagnosticsMarker}`;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const idx = line.indexOf(marker);
		if (idx < 0) continue;
		// Trim trailing whitespace between the original line content and
		// our injected marker (the injection shape was
		// `${line} ${commentPrefix} ${marker} … - …`).
		let cut = idx;
		while (cut > 0 && (line[cut - 1] === " " || line[cut - 1] === "\t")) {
			cut--;
		}
		lines[i] = line.slice(0, cut);
	}
}
