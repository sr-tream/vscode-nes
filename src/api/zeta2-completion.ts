// Postprocessing for Zeta2 model output. Mirrors parseCompletion in
// cursortab.nvim's server/provider/zeta2/zeta2.go: strip the trailing
// >>>>>>> UPDATED end marker, short-circuit on the NO_EDITS sentinel,
// strip <|user_cursor|> markers, then map the editable-region replacement
// to a UTF-8 byte-offset edit on the user's document.
//
// Unlike Sweep, the model output is *only* the new editable region (not
// a full window rewrite), so trimCommonEnds runs against the editable
// slice rather than the full original/current/updated window.

import { logger } from "~/core/logger.ts";
import type { CompletionResult } from "./completion-client.ts";
import type { ModelPrompt } from "./model-format.ts";
import type { AutocompleteResponse } from "./schemas.ts";
import {
	ZETA2_CURSOR_MARKER,
	ZETA2_END_MARKER,
	ZETA2_NO_EDITS,
} from "./zeta2-prompt.ts";

export function buildZeta2Response(
	completion: CompletionResult,
	prompt: ModelPrompt,
	autocompleteId: string,
): AutocompleteResponse | null {
	if (completion.finishReason === "length") return null;

	let text = completion.text;

	// Strip trailing end marker (with or without newline).
	if (text.endsWith(ZETA2_END_MARKER)) {
		text = text.slice(0, -ZETA2_END_MARKER.length);
	} else {
		const trimmed = ZETA2_END_MARKER.replace(/\n$/, "");
		if (text.endsWith(trimmed)) {
			text = text.slice(0, -trimmed.length);
		}
	}

	if (text.trimStart().startsWith(ZETA2_NO_EDITS)) return null;

	// Replace the FIRST cursor marker with a sentinel so we can track the
	// post-edit cursor position through the line-diff and surface it as a
	// snippet $0 placeholder. We accept both <|user_cursor|> (Zeta2's
	// trained marker) and <|cursor|> (sweep-style — some SeedCoder
	// checkpoints echo it back). Extra markers are stripped silently.
	const markerCount = countCursorMarkers(text);
	if (markerCount > 0) {
		logger.debug(
			`zeta2 response contained ${markerCount} cursor marker(s); stripping`,
		);
	}
	text = injectCursorSentinel(text);
	text = text.replace(/[ \t\n\r]+$/g, "");
	if (text.replace(SENTINEL, "").trim() === "") return null;

	const stripped = stripRepetition(text);
	if (stripped === null) return null;

	const newLines = stripped.split("\n");
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
		// Pure insertion — splice new lines in front of the suffix line.
		endByte = startByte;
		completionText = `${newMiddle.join("\n")}\n`;
	} else if (newMiddle.length === 0) {
		// Pure deletion — gobble the trailing newline of the last removed line.
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
			`zeta2 cursor target at offset ${cursorTargetOffset} of ${completionText.length}-char completion`,
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

// U+E000 (Private Use Area) — never appears in real source, so it survives
// line-splitting / repetition trimming / line-diff trimming intact.
const SENTINEL = String.fromCharCode(0xe000);
const CURSOR_MARKERS = [ZETA2_CURSOR_MARKER, "<|cursor|>"];

function countCursorMarkers(text: string): number {
	let n = 0;
	for (const m of CURSOR_MARKERS) {
		const parts = text.split(m).length - 1;
		n += parts;
	}
	return n;
}

function injectCursorSentinel(text: string): string {
	let firstIdx = -1;
	let firstLen = 0;
	for (const m of CURSOR_MARKERS) {
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
	for (const m of CURSOR_MARKERS) {
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

interface TrimmedDiff {
	skipPrefix: number;
	oldMiddle: string[];
	newMiddle: string[];
}

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
