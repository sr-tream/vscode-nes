import * as vscode from "vscode";

export const INLINE_COMPLETION_DISPLAY_LOCATION_KIND = {
	Code: 1,
	Label: 2,
} as const;

export type InlineCompletionDisplayLocationKind =
	(typeof INLINE_COMPLETION_DISPLAY_LOCATION_KIND)[keyof typeof INLINE_COMPLETION_DISPLAY_LOCATION_KIND];

export interface ProposedInlineCompletionDisplayLocation {
	range: vscode.Range;
	kind: InlineCompletionDisplayLocationKind;
	label: string;
}

export interface ProposedInlineCompletionItem
	extends vscode.InlineCompletionItem {
	isInlineEdit?: boolean;
	showRange?: vscode.Range;
	showInlineEditMenu?: boolean;
	displayLocation?: ProposedInlineCompletionDisplayLocation;
	correlationId?: string;
}

export interface ProposedInlineCompletionList
	extends vscode.InlineCompletionList {
	enableForwardStability?: boolean;
}

export interface InlineCompletionItemProviderMetadata {
	groupId?: string;
	debounceDelayMs?: number;
	displayName?: string;
	excludes?: string[];
	yieldTo?: string[];
}

type RegisterInlineCompletionItemProviderWithMetadata = (
	selector: vscode.DocumentSelector,
	provider: vscode.InlineCompletionItemProvider,
	metadata?: InlineCompletionItemProviderMetadata,
) => vscode.Disposable;

export function markAsProposedInlineEdit(
	item: vscode.InlineCompletionItem,
	options: {
		showRange?: vscode.Range;
		displayLocation?: ProposedInlineCompletionDisplayLocation;
		correlationId: string;
	},
): ProposedInlineCompletionItem {
	const proposed = item as ProposedInlineCompletionItem;
	proposed.isInlineEdit = true;
	proposed.showInlineEditMenu = true;
	if (options.showRange) {
		proposed.showRange = options.showRange;
	}
	if (options.displayLocation) {
		proposed.displayLocation = options.displayLocation;
	}
	proposed.correlationId = options.correlationId;
	return proposed;
}

export function enableForwardStability(
	list: vscode.InlineCompletionList,
): ProposedInlineCompletionList {
	const proposed = list as ProposedInlineCompletionList;
	proposed.enableForwardStability = true;
	return proposed;
}

export function registerInlineCompletionItemProviderWithMetadata(
	selector: vscode.DocumentSelector,
	provider: vscode.InlineCompletionItemProvider,
	metadata: InlineCompletionItemProviderMetadata,
): vscode.Disposable {
	const register = vscode.languages
		.registerInlineCompletionItemProvider as RegisterInlineCompletionItemProviderWithMetadata;
	return register(selector, provider, metadata);
}
