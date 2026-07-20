import { describe, expect, test } from "bun:test";

import { detectModelFormat } from "~/api/model-format.ts";
import type { AutocompleteRequest } from "~/api/schemas.ts";
import { buildSweepPrompt } from "~/api/sweep-prompt.ts";
import {
	buildZeta2Prompt,
	ZETA2_CURRENT_MARKER,
	ZETA2_CURSOR_MARKER,
	ZETA2_SEPARATOR,
	ZETA2_STOP_TOKENS,
} from "~/api/zeta2-prompt.ts";

function makeRequest(
	overrides: Partial<AutocompleteRequest> = {},
): AutocompleteRequest {
	const fileContents = "line0\nline1\nline2 cursor here\nline3\nline4\n";
	const cursorLineStart = "line0\nline1\n".length;
	const cursorPosition = cursorLineStart + "line2 ".length;
	return {
		debug_info: "test",
		repo_name: "demo",
		file_path: "src/foo.ts",
		file_contents: fileContents,
		original_file_contents: fileContents,
		cursor_position: cursorPosition,
		recent_changes: "",
		changes_above_cursor: false,
		multiple_suggestions: false,
		file_chunks: [],
		retrieval_chunks: [],
		editor_diagnostics: [],
		recent_user_actions: [],
		use_bytes: true,
		...overrides,
	};
}

describe("detectModelFormat", () => {
	test("default (sweep) for unknown names", () => {
		expect(detectModelFormat("sweepai/sweep-next-edit")).toBe("sweep");
		expect(detectModelFormat("foo/bar-baz")).toBe("sweep");
	});

	test("matches zeta2 family by substring", () => {
		expect(detectModelFormat("zed-industries/zeta2")).toBe("zeta2");
		expect(detectModelFormat("Zeta-2-q4")).toBe("zeta2");
		expect(detectModelFormat("seedcoder-8b-edit")).toBe("zeta2");
		expect(detectModelFormat("seed-coder/edit-prediction")).toBe("zeta2");
	});

	test("zeta2.1 takes precedence over the zeta2 substring", () => {
		// "zeta-2.1" contains "zeta-2" — order matters in detectModelFormat.
		expect(detectModelFormat("zed-industries/zeta-2.1")).toBe("zeta2.1");
		expect(detectModelFormat("zeta2.1-q4")).toBe("zeta2.1");
		expect(detectModelFormat("zeta-2-1")).toBe("zeta2.1");
		expect(detectModelFormat("Zeta_2_1")).toBe("zeta2.1");
	});
});

describe("buildSweepPrompt", () => {
	test("emits <|file_sep|> sections, <|cursor|> marker, sweep stop tokens", () => {
		const result = buildSweepPrompt(makeRequest());
		expect(result.format).toBe("sweep");
		expect(result.stopTokens).toEqual(["<|file_sep|>", "<|endoftext|>"]);
		expect(result.prompt).toContain("<|file_sep|>src/foo.ts");
		expect(result.prompt).toContain("<|file_sep|>original/src/foo.ts");
		expect(result.prompt).toContain("<|file_sep|>current/src/foo.ts");
		expect(result.prompt).toContain("<|file_sep|>updated/src/foo.ts");
		expect(result.prompt).toContain("<|cursor|>");
	});

	test("places active broad context after stable retrieval context", () => {
		const result = buildSweepPrompt(
			makeRequest({
				retrieval_chunks: [
					{
						file_path: "src/other.ts",
						start_line: 1,
						end_line: 1,
						content: "const stable = true;",
						timestamp: 1,
					},
				],
				recent_changes: "File: src/foo.ts:\n@@\n-old\n+new",
			}),
		);
		const retrieval = result.prompt.indexOf("<|file_sep|>context/retrieval");
		const diff = result.prompt.indexOf("<|file_sep|>recent_changes");
		const active = result.prompt.indexOf("<|file_sep|>src/foo.ts");
		const original = result.prompt.indexOf("<|file_sep|>original/src/foo.ts");
		expect(retrieval).toBeGreaterThanOrEqual(0);
		expect(diff).toBeGreaterThan(retrieval);
		expect(active).toBeGreaterThan(diff);
		expect(original).toBeGreaterThan(active);
	});
});

describe("buildZeta2Prompt", () => {
	test("emits SeedCoder FIM layout with the cursor marker inside CURRENT block", () => {
		const result = buildZeta2Prompt(makeRequest());
		expect(result.format).toBe("zeta2");
		expect(result.stopTokens).toEqual(ZETA2_STOP_TOKENS);
		expect(result.prefill).toBe("");

		// Order: <[fim-suffix]> ... <[fim-prefix]> ... CURRENT ... ======= ... <[fim-middle]>
		const suffixIdx = result.prompt.indexOf("<[fim-suffix]>");
		const prefixIdx = result.prompt.indexOf("<[fim-prefix]>");
		const currentIdx = result.prompt.indexOf(ZETA2_CURRENT_MARKER);
		const sepIdx = result.prompt.indexOf(ZETA2_SEPARATOR);
		const middleIdx = result.prompt.indexOf("<[fim-middle]>");

		expect(suffixIdx).toBe(0);
		expect(prefixIdx).toBeGreaterThan(suffixIdx);
		expect(currentIdx).toBeGreaterThan(prefixIdx);
		expect(sepIdx).toBeGreaterThan(currentIdx);
		expect(middleIdx).toBeGreaterThan(sepIdx);

		// <|user_cursor|> is inside the CURRENT block, ends with <[fim-middle]>.
		const cursorIdx = result.prompt.indexOf(ZETA2_CURSOR_MARKER);
		expect(cursorIdx).toBeGreaterThan(currentIdx);
		expect(cursorIdx).toBeLessThan(sepIdx);
		expect(result.prompt.endsWith("<[fim-middle]>")).toBe(true);
	});

	test("editable region is centered on the cursor line (±15 lines)", () => {
		// Generate a 100-line file, cursor on line 50.
		const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
		const fileContents = `${lines.join("\n")}\n`;
		// cursor at start of line 50
		const cursorPos = lines.slice(0, 50).join("\n").length + 1;
		const result = buildZeta2Prompt(
			makeRequest({ file_contents: fileContents, cursor_position: cursorPos }),
		);

		// Editable window: [50-15, 50+15+1) = [35, 66)
		expect(result.windowStartLine).toBe(35);
		expect(result.windowEndLine).toBe(66);
	});

	test("protocolVersion 2.1 swaps to <|marker_1|> / <|marker_2|>", () => {
		const result = buildZeta2Prompt(makeRequest(), { protocolVersion: "2.1" });
		expect(result.format).toBe("zeta2.1");
		expect(result.stopTokens).toEqual(["<|marker_2|>"]);

		// 2.1 uses paired numbered markers around the editable region —
		// no git-conflict scaffolding.
		expect(result.prompt).toContain("<|marker_1|>\n");
		expect(result.prompt).toContain("<|marker_2|>\n");
		expect(result.prompt).not.toContain(ZETA2_CURRENT_MARKER);
		expect(result.prompt).not.toContain(ZETA2_SEPARATOR);

		// Order: <|marker_1|> ... <|user_cursor|> ... <|marker_2|> ... <[fim-middle]>
		const m1 = result.prompt.indexOf("<|marker_1|>\n");
		const cursorIdx = result.prompt.indexOf(ZETA2_CURSOR_MARKER);
		const m2 = result.prompt.indexOf("<|marker_2|>\n");
		const middleIdx = result.prompt.indexOf("<[fim-middle]>");
		expect(m1).toBeGreaterThan(0);
		expect(cursorIdx).toBeGreaterThan(m1);
		expect(cursorIdx).toBeLessThan(m2);
		expect(middleIdx).toBeGreaterThan(m2);
		expect(result.prompt.endsWith("<[fim-middle]>")).toBe(true);
	});
});
