import { describe, expect, test } from "bun:test";

import { formatRecentChanges } from "~/api/client.ts";

function diffWithBody(bodyLines: string[]): string {
	return [
		"Index: src/example.ts",
		"===================================================================",
		"--- src/example.ts",
		"+++ src/example.ts",
		"@@ -1,1 +1,1 @@",
		...bodyLines,
	].join("\n");
}

describe("formatRecentChanges", () => {
	test("omits history when the character budget is zero", () => {
		const result = formatRecentChanges(
			[{ path: "src/example.ts", diff: diffWithBody(["+const x = 1;"]) }],
			0,
		);

		expect(result).toBe("");
	});

	test("keeps multiple small cleaned diff records", () => {
		const result = formatRecentChanges(
			[
				{ path: "src/a.ts", diff: diffWithBody(["+const a = 1;"]) },
				{ path: "src/b.ts", diff: diffWithBody(["+const b = 2;"]) },
			],
			1000,
		);

		expect(result).toContain("File: src/a.ts:");
		expect(result).toContain("File: src/b.ts:");
		expect(result).toContain("@@ -1,1 +1,1 @@");
		expect(result).not.toContain("Index:");
		expect(result).not.toContain("--- src/example.ts");
		expect(result).not.toContain("+++ src/example.ts");
	});

	test("caps formatted history by characters, not just record count", () => {
		const body = Array.from({ length: 80 }, (_, i) => `+line ${i}`);
		const result = formatRecentChanges(
			[
				{ path: "src/huge.ts", diff: diffWithBody(body) },
				{ path: "src/later.ts", diff: diffWithBody(["+should not fit"]) },
			],
			220,
		);

		expect(result.length).toBeLessThanOrEqual(220);
		expect(result).toContain("File: src/huge.ts:");
		expect(result).toContain("...[truncated]");
		expect(result).not.toContain("File: src/later.ts:");
	});
});
