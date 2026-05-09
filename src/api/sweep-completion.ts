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

import type { CompletionResult } from "./completion-client.ts";
import type { AutocompleteResponse } from "./schemas.ts";
import type { SweepPrompt } from "./sweep-prompt.ts";

const STOP_MARKERS = ["<|file_sep|>", "<|endoftext|>"];

export function buildAutocompleteResponse(
	completion: CompletionResult,
	prompt: SweepPrompt,
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
	for (const marker of STOP_MARKERS) {
		const idx = text.indexOf(marker);
		if (idx !== -1) text = text.slice(0, idx);
	}
	text = text.replace(/[ \t\n\r]+$/g, "");
	if (text.trim() === "") return null;

	const fullText = prompt.prefill + text;
	const stripped = stripRepetition(fullText);
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

	if (completionText.length === 0 && endByte === startByte) return null;

	return {
		autocomplete_id: autocompleteId,
		start_index: startByte,
		end_index: endByte,
		completion: completionText,
		confidence: 0.8,
		finish_reason: completion.finishReason,
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
	let skipPrefix = 0;
	const minLen = Math.min(oldLines.length, newLines.length);
	while (skipPrefix < minLen && oldLines[skipPrefix] === newLines[skipPrefix]) {
		skipPrefix++;
	}

	let skipSuffix = 0;
	const remainingOld = oldLines.length - skipPrefix;
	const remainingNew = newLines.length - skipPrefix;
	const maxSuffix = Math.min(remainingOld, remainingNew);
	while (
		skipSuffix < maxSuffix &&
		oldLines[oldLines.length - 1 - skipSuffix] ===
			newLines[newLines.length - 1 - skipSuffix]
	) {
		skipSuffix++;
	}

	const oldMiddle = oldLines.slice(skipPrefix, oldLines.length - skipSuffix);
	const newMiddle = newLines.slice(skipPrefix, newLines.length - skipSuffix);
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
