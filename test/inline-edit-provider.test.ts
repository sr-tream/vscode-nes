import { afterEach, describe, expect, test } from "bun:test";
import * as vscode from "vscode";

import type { ApiClient } from "~/api/client.ts";
import type { AutocompleteResult } from "~/api/schemas.ts";
import {
	InlineEditProvider,
	inlineEditMatchesSelectedCompletion,
} from "~/editor/inline-edit-provider.ts";
import type { JumpEditManager } from "~/editor/jump-edit-manager.ts";
import type { DocumentTracker } from "~/telemetry/document-tracker.ts";

function makeOneLineDocument(text: string): vscode.TextDocument {
	return {
		uri: { toString: () => "file:///test.ts" },
		version: 1,
		getText: (range?: vscode.Range) => {
			if (!range) return text;
			const start = (range.start as vscode.Position).character;
			const end = (range.end as vscode.Position).character;
			return text.slice(start, end);
		},
		offsetAt: (position: vscode.Position) => position.character,
		positionAt: (offset: number) => new vscode.Position(0, offset),
	} as vscode.TextDocument;
}

function buildItem(
	document: vscode.TextDocument,
	position: vscode.Position,
	result: AutocompleteResult,
	options?: { useProposedInlineEditPresentation?: boolean },
	jumpEditManager = {} as JumpEditManager,
) {
	const provider = new InlineEditProvider(
		{} as DocumentTracker,
		jumpEditManager,
		{} as ApiClient,
	) as unknown as {
		buildCompletionItem: (
			document: vscode.TextDocument,
			position: vscode.Position,
			result: AutocompleteResult,
			options?: { useProposedInlineEditPresentation?: boolean },
		) => vscode.InlineCompletionList | undefined;
	};

	return provider.buildCompletionItem(document, position, result, options)
		?.items[0];
}

function setMockConfiguration(values: Record<string, unknown>): void {
	(
		globalThis as typeof globalThis & { __vscodeMockConfiguration?: unknown }
	).__vscodeMockConfiguration = values;
}

afterEach(() => {
	setMockConfiguration({});
});

describe("InlineEditProvider buildCompletionItem", () => {
	test("sets filterText when replacing text that is not a prefix of the completion", () => {
		const text = "const value = oldCall();";
		const cursorOffset = "const value = ".length;
		const document = makeOneLineDocument(text);

		const item = buildItem(document, new vscode.Position(0, cursorOffset), {
			id: "non-prefix-replacement",
			startIndex: cursorOffset,
			endIndex: text.length,
			completion: "newCall()",
			confidence: 0.8,
		});

		expect(item?.filterText).toBe("oldCall();");
	});

	test("leaves filterText unset when replaced text is already a prefix", () => {
		const text = "const value = high";
		const cursorOffset = "const value = ".length;
		const document = makeOneLineDocument(text);

		const item = buildItem(document, new vscode.Position(0, cursorOffset), {
			id: "prefix-replacement",
			startIndex: cursorOffset,
			endIndex: text.length,
			completion: "highWatermark",
			confidence: 0.8,
		});

		expect(item?.filterText).toBeUndefined();
	});

	test("can render edits before the cursor as proposed inline edits when enabled", () => {
		setMockConfiguration({
			useCopilotStyleNextEditPresentation: true,
		});
		const text = "const value = oldValue;";
		const startIndex = "const value = ".length;
		const endIndex = "const value = oldValue".length;
		const document = makeOneLineDocument(text);

		const item = buildItem(
			document,
			new vscode.Position(0, text.length),
			{
				id: "before-cursor-proposed-inline-edit",
				startIndex,
				endIndex,
				completion: "newValue",
				confidence: 0.8,
			},
			{ useProposedInlineEditPresentation: true },
		) as vscode.InlineCompletionItem & {
			isInlineEdit?: boolean;
			showInlineEditMenu?: boolean;
			showRange?: vscode.Range;
			displayLocation?: unknown;
		};

		expect(item?.isInlineEdit).toBe(true);
		expect(item?.showInlineEditMenu).toBe(true);
		expect(item?.showRange).toBeUndefined();
		expect(item?.displayLocation).toBeUndefined();
	});

	test("uses the custom jump fallback by default", () => {
		const text = "const value = oldValue;";
		const startIndex = "const value = ".length;
		const endIndex = "const value = oldValue".length;
		const document = makeOneLineDocument(text);
		let fallbackResult: AutocompleteResult | undefined;

		const item = buildItem(
			document,
			new vscode.Position(0, text.length),
			{
				id: "before-cursor-custom-jump",
				startIndex,
				endIndex,
				completion: "newValue",
				confidence: 0.8,
			},
			{ useProposedInlineEditPresentation: true },
			{
				setPendingJumpEdit: (
					_document: vscode.TextDocument,
					result: AutocompleteResult,
				) => {
					fallbackResult = result;
				},
			} as JumpEditManager,
		);

		expect(item).toBeUndefined();
		expect(fallbackResult?.id).toBe("before-cursor-custom-jump");
	});
});

describe("inlineEditMatchesSelectedCompletion", () => {
	test("allows inline edits that use the selected completion range and extend its text", () => {
		const text = "console.";
		const document = makeOneLineDocument(text);
		const range = new vscode.Range(
			new vscode.Position(0, "console".length),
			new vscode.Position(0, text.length),
		);

		const matches = inlineEditMatchesSelectedCompletion(
			document,
			{
				id: "extends-selected",
				startIndex: "console".length,
				endIndex: text.length,
				completion: ".log()",
				confidence: 0.8,
			},
			{ range, text: ".log" },
		);

		expect(matches).toBe(true);
	});

	test("rejects inline edits that use a different range than the selected completion", () => {
		const text = "console.";
		const document = makeOneLineDocument(text);
		const selectedRange = new vscode.Range(
			new vscode.Position(0, "console".length),
			new vscode.Position(0, text.length),
		);

		const matches = inlineEditMatchesSelectedCompletion(
			document,
			{
				id: "different-range",
				startIndex: 0,
				endIndex: text.length,
				completion: "console.log()",
				confidence: 0.8,
			},
			{ range: selectedRange, text: ".log" },
		);

		expect(matches).toBe(false);
	});

	test("rejects inline edits that do not extend the selected completion text", () => {
		const text = "import ";
		const document = makeOneLineDocument(text);
		const range = new vscode.Range(
			new vscode.Position(0, text.length),
			new vscode.Position(0, text.length),
		);

		const matches = inlineEditMatchesSelectedCompletion(
			document,
			{
				id: "does-not-extend",
				startIndex: text.length,
				endIndex: text.length,
				completion: '"./thing";',
				confidence: 0.8,
			},
			{ range, text: "Button" },
		);

		expect(matches).toBe(false);
	});
});
