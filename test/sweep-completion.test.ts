import { describe, expect, test } from "bun:test";

import type { CompletionResult } from "~/api/completion-client.ts";
import type { ModelPrompt, PromptLine } from "~/api/model-format.ts";
import { buildSweepResponse } from "~/api/sweep-completion.ts";
import { computeLineByteOffsets, splitLines } from "~/api/sweep-prompt.ts";

function makePrompt(
	fileContents: string,
	windowStartLine: number,
	windowEndLine: number,
	prefill: string,
): ModelPrompt {
	const lines = splitLines(fileContents);
	const lineOffsets = computeLineByteOffsets(lines);
	const promptLines: PromptLine[] = lines.map((content, i) => ({
		startByte: lineOffsets[i] ?? 0,
		content,
	}));
	return {
		prompt: "",
		prefill,
		format: "sweep",
		stopTokens: ["<|file_sep|>", "<|endoftext|>"],
		windowStartLine,
		windowEndLine,
		lines: promptLines,
		cursorLineByteOffsets: lineOffsets,
	};
}

function completion(text: string): CompletionResult {
	return { text, finishReason: "stop" };
}

describe("buildSweepResponse trimCommonEnds — trailing newline alignment", () => {
	test("model emits cursor line + trailing function body with file-final-newline phantom", () => {
		// Reproduces the ShowIntermediateFrame bug: the cursor sits on a
		// `\tspdlog:` line near the end of the file; the model echoes the
		// full window with only the cursor line changed; splitLines on the
		// trailing '\n' adds a phantom "" that previously broke the suffix
		// match, causing the diff to span 8+ lines instead of 1.
		const fileBefore = [
			"void ShowIntermediateFrame() {",
			"\tspdlog:",
			"\tauto *camera = RwCamera::get();",
			"\tRwCameraEndUpdate( camera );",
			"",
			"\tOnRsCameraShowRaster( camera );",
			"",
			"\tRsCameraBeginUpdate( camera );",
			"}",
			"",
		].join("\n");
		// Cursor right after `\tspdlog:` on line index 1.
		const cursorLineStart = "void ShowIntermediateFrame() {\n".length;
		const cursorByte = cursorLineStart + "\tspdlog:".length;

		// Sweep window covers the whole file; prefill is everything up to
		// (and including) the newline before the cursor line, mirroring
		// computePrefill's changesAboveCursor=false branch.
		const prefill = "void ShowIntermediateFrame() {\n";
		const prompt = makePrompt(
			fileBefore,
			0,
			splitLines(fileBefore).length,
			prefill,
		);

		// Model continues from prefill, emitting the cursor-line replacement
		// and re-emitting the trailing 7 lines verbatim.
		const modelOutput = [
			'\tspdlog::debug("Showing intermediate frame");',
			"\tauto *camera = RwCamera::get();",
			"\tRwCameraEndUpdate( camera );",
			"",
			"\tOnRsCameraShowRaster( camera );",
			"",
			"\tRsCameraBeginUpdate( camera );",
			"}",
		].join("\n");

		const response = buildSweepResponse(
			completion(modelOutput),
			prompt,
			"id-1",
		);
		expect(response).not.toBeNull();
		if (!response) return;

		// Edit must be a single-line replacement of `\tspdlog:` with
		// `\tspdlog::debug(...)`, not a wholesale window rewrite.
		// (Cursor-anchoring to a pure insertion happens later in client.ts;
		// this layer just reports the byte range for the changed line.)
		expect(response.start_index).toBe(cursorLineStart);
		expect(response.end_index).toBe(cursorByte);
		expect(response.completion).toBe(
			'\tspdlog::debug("Showing intermediate frame");',
		);
	});

	test("trailing-newline file: cursor mid-file edit isn't dragged to EOF", () => {
		// Same alignment regression but with the cursor far from EOF, to
		// confirm the trailing-empty drop doesn't reach into legitimate
		// in-window blank lines.
		const fileContents = ["a", "b cursor", "c", "", "d", ""].join("\n"); // ends with '\n' → splitLines yields a trailing ""
		const prefill = "a\n";
		const prompt = makePrompt(
			fileContents,
			0,
			splitLines(fileContents).length,
			prefill,
		);

		const modelOutput = ["b cursor edited", "c", "", "d"].join("\n");
		const response = buildSweepResponse(
			completion(modelOutput),
			prompt,
			"id-2",
		);
		expect(response).not.toBeNull();
		if (!response) return;

		// Should target only line 1 ("b cursor" → "b cursor edited"), not
		// extend through the trailing blank line at index 5 / EOF.
		expect(response.start_index).toBe("a\n".length);
		expect(response.end_index).toBe("a\nb cursor".length);
		expect(response.completion).toBe("b cursor edited");
	});
});
