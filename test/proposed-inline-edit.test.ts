import { describe, expect, test } from "bun:test";
import * as vscode from "vscode";

import {
	enableForwardStability,
	INLINE_COMPLETION_DISPLAY_LOCATION_KIND,
	markAsProposedInlineEdit,
} from "~/editor/proposed-inline-edit.ts";

describe("proposed inline edit presentation", () => {
	test("marks an item as a VS Code inline edit with a menu and display location", () => {
		const editRange = new vscode.Range(
			new vscode.Position(10, 2),
			new vscode.Position(10, 8),
		);
		const displayRange = new vscode.Range(
			new vscode.Position(3, 0),
			new vscode.Position(3, 0),
		);
		const item = new vscode.InlineCompletionItem("replacement", editRange);

		const proposed = markAsProposedInlineEdit(item, {
			showRange: editRange,
			displayLocation: {
				range: displayRange,
				label: "Edit at line 11",
				kind: INLINE_COMPLETION_DISPLAY_LOCATION_KIND.Label,
			},
			correlationId: "nesweep-test",
		});

		expect(proposed.isInlineEdit).toBe(true);
		expect(proposed.showInlineEditMenu).toBe(true);
		expect(proposed.showRange).toBe(editRange);
		expect(proposed.displayLocation?.range).toBe(displayRange);
		expect(proposed.displayLocation?.label).toBe("Edit at line 11");
		expect(proposed.displayLocation?.kind).toBe(
			INLINE_COMPLETION_DISPLAY_LOCATION_KIND.Label,
		);
		expect(proposed.correlationId).toBe("nesweep-test");
	});

	test("enables forward stability on returned inline completion lists", () => {
		const list: vscode.InlineCompletionList = { items: [] };

		const proposed = enableForwardStability(list);

		expect(proposed.enableForwardStability).toBe(true);
	});
});
