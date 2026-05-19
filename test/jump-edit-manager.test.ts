import { afterEach, describe, expect, test } from "bun:test";
import * as vscode from "vscode";

import { JumpEditManager } from "~/editor/jump-edit-manager.ts";

function makeDocument(text: string): vscode.TextDocument {
	const lines = text.split("\n");
	return {
		uri: { toString: () => "file:///jump-test.ts" },
		version: 1,
		lineCount: lines.length,
		languageId: "typescript",
		getText: (range?: vscode.Range) => {
			if (!range) return text;
			const start = offsetAt(range.start as vscode.Position);
			const end = offsetAt(range.end as vscode.Position);
			return text.slice(start, end);
		},
		offsetAt,
		positionAt: (offset: number) => {
			let remaining = offset;
			for (let line = 0; line < lines.length; line++) {
				const lineLength = lines[line]?.length ?? 0;
				if (remaining <= lineLength) {
					return new vscode.Position(line, remaining);
				}
				remaining -= lineLength + 1;
			}
			const lastLine = Math.max(0, lines.length - 1);
			return new vscode.Position(lastLine, lines[lastLine]?.length ?? 0);
		},
		lineAt: (line: number) => {
			const lineText = lines[line] ?? "";
			return {
				text: lineText,
				range: new vscode.Range(
					new vscode.Position(line, 0),
					new vscode.Position(line, lineText.length),
				),
			};
		},
	} as vscode.TextDocument;

	function offsetAt(position: vscode.Position): number {
		let offset = 0;
		for (let line = 0; line < position.line; line++) {
			offset += (lines[line]?.length ?? 0) + 1;
		}
		return offset + position.character;
	}
}

afterEach(() => {
	(
		vscode.window as unknown as { activeTextEditor?: unknown }
	).activeTextEditor = undefined;
});

describe("JumpEditManager", () => {
	test("fallback jump hint advertises Alt+Tab instead of Tab", () => {
		const document = makeDocument(
			"const oldValue = 1;\nconsole.log(oldValue);",
		);
		const capturedDecorations: vscode.DecorationOptions[][] = [];
		const editor = {
			document,
			options: { tabSize: 4 },
			selection: {
				active: new vscode.Position(1, 0),
			},
			setDecorations: (
				_decorationType: vscode.TextEditorDecorationType,
				options: vscode.DecorationOptions[],
			) => {
				capturedDecorations.push(options);
			},
		};
		(
			vscode.window as unknown as { activeTextEditor?: unknown }
		).activeTextEditor = editor;

		const manager = new JumpEditManager();
		manager.setPendingJumpEdit(document, {
			id: "jump-hint",
			startIndex: 6,
			endIndex: 14,
			completion: "newValue",
			confidence: 0.8,
		});

		const hint = capturedDecorations
			.flat()
			.find((option) =>
				option.renderOptions?.after?.contentText?.includes("Edit at line"),
			);

		expect(hint?.renderOptions?.after?.contentText).toContain("Alt+Tab");
		expect(hint?.renderOptions?.after?.contentText).not.toContain("Tab ✓");

		manager.dispose();
	});
});
