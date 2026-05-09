import * as vscode from "vscode";
import type { ApiClient, AutocompleteInput } from "~/api/client.ts";
import type { AutocompleteResult } from "~/api/schemas.ts";
import { config } from "~/core/config";
import { logger } from "~/core/logger.ts";
import type { JumpEditManager } from "~/editor/jump-edit-manager.ts";
import type { DocumentTracker } from "~/telemetry/document-tracker.ts";
import { toUnixPath } from "~/utils/path.ts";
import { isFileTooLarge, utf8ByteOffsetAt } from "~/utils/text.ts";

const INLINE_REQUEST_DEBOUNCE_MS = 300;
const MAX_FILE_CHUNK_LINES = 60;
const BULK_CHANGE_LOOKBACK_MS = 1500;
const BULK_CHANGE_CHAR_THRESHOLD = 200;
const BULK_CHANGE_LINE_THRESHOLD = 8;
const SELECTION_LOOKBACK_MS = 5000;

interface QueuedSuggestionState {
	uri: string;
	suggestions: AutocompleteResult[];
}

interface RequestSnapshot {
	uri: string;
	version: number;
	position: vscode.Position;
	content: string;
	cursorOffset: number;
}

interface AcceptedInlineSuggestion {
	id: string;
	startIndex: number;
	endIndex: number;
	completion: string;
}

// Build a SnippetString that places the final cursor ($0) at the model's
// predicted post-edit position. Snippet metacharacters in the surrounding
// text need to be escaped — `$`, `}` and `\` would otherwise be parsed as
// snippet syntax.
function toSnippetWithCursor(
	completion: string,
	cursorOffset: number,
): vscode.SnippetString {
	const escapeSnippet = (s: string) => s.replace(/[\\$}]/g, "\\$&");
	const before = escapeSnippet(completion.slice(0, cursorOffset));
	const after = escapeSnippet(completion.slice(cursorOffset));
	return new vscode.SnippetString(`${before}$0${after}`);
}

export class InlineEditProvider implements vscode.InlineCompletionItemProvider {
	private tracker: DocumentTracker;
	private jumpEditManager: JumpEditManager;
	private api: ApiClient;
	private lastInlineEdit: {
		uri: string;
		line: number;
		character: number;
		version: number;
		suggestion: AcceptedInlineSuggestion;
	} | null = null;
	private queuedSuggestions: QueuedSuggestionState | null = null;
	private shouldConsumeQueuedSuggestion = false;
	private requestCounter = 0;
	private latestRequestId = 0;
	private inFlightRequest: {
		id: number;
		controller: AbortController;
		uri: string;
		snapshot: RequestSnapshot;
		response: Promise<AutocompleteResult[] | null>;
	} | null = null;
	private lastRequestTimestamp = 0;

	constructor(
		tracker: DocumentTracker,
		jumpEditManager: JumpEditManager,
		api: ApiClient,
	) {
		this.tracker = tracker;
		this.jumpEditManager = jumpEditManager;
		this.api = api;
	}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionList | undefined> {
		const requestId = ++this.requestCounter;
		this.latestRequestId = requestId;

		if (!config.enabled) return undefined;
		if (config.isAutocompleteSnoozed()) return undefined;

		const suppressionReason = await this.getSuppressionReason(document);
		if (suppressionReason) {
			logger.debug("Suppressing inline edit:", suppressionReason);
			return undefined;
		}
		logger.debug(
			`provider invoked req=${requestId} line=${position.line} char=${position.character}`,
		);

		const uri = document.uri.toString();
		const filePath = document.uri.fsPath;
		if (filePath && config.shouldExcludeFromAutocomplete(filePath)) {
			return undefined;
		}
		const currentContent = document.getText();
		const requestSnapshot: RequestSnapshot = {
			uri,
			version: document.version,
			position,
			content: currentContent,
			cursorOffset: document.offsetAt(position),
		};
		const originalContent =
			this.tracker.getOriginalContent(uri) ?? currentContent;

		if (isFileTooLarge(currentContent) || isFileTooLarge(originalContent)) {
			logger.debug("Skipping inline edit: file too large", {
				uri,
				currentLength: currentContent.length,
				originalLength: originalContent.length,
			});
			return undefined;
		}

		if (currentContent === originalContent) return undefined;
		if (this.shouldConsumeQueuedSuggestion) {
			const queuedItems = this.consumeQueuedSuggestion(document, position);
			if (queuedItems) {
				return queuedItems;
			}
		}

		if (token.isCancellationRequested) return undefined;

		const shouldContinue = await this.waitForDebounce(requestId, token);
		if (!shouldContinue) return undefined;
		if (!this.isLatestRequest(requestId)) return undefined;

		const setupOriginate = (): Promise<AutocompleteResult[] | null> => {
			this.cancelInFlightRequest("superseded by new request");
			const controller = new AbortController();
			const input = this.buildInput(document, position, originalContent);
			const promise = this.api.getAutocomplete(input, controller.signal);
			const inFlight = {
				id: requestId,
				controller,
				uri,
				snapshot: requestSnapshot,
				response: promise,
			};
			this.inFlightRequest = inFlight;
			promise.finally(() => {
				if (this.inFlightRequest === inFlight) {
					this.inFlightRequest = null;
				}
			});
			return promise;
		};

		let sourceSnapshot: RequestSnapshot;
		let responsePromise: Promise<AutocompleteResult[] | null>;
		const piggyback = this.tryPiggyback(uri, requestSnapshot);
		if (piggyback) {
			logger.debug(
				`Piggybacking req=${requestId} on in-flight req=${piggyback.id}`,
			);
			sourceSnapshot = piggyback.snapshot;
			responsePromise = piggyback.response;
		} else {
			sourceSnapshot = requestSnapshot;
			responsePromise = setupOriginate();
		}

		try {
			let responseResults = await responsePromise;

			// Piggyback fallback: if reusing the in-flight produced no usable
			// result for our snapshot, originate fresh before giving up. Only
			// do this for the latest request — older provider calls just bail.
			if (
				piggyback &&
				config.enabled &&
				!token.isCancellationRequested &&
				this.isLatestRequest(requestId)
			) {
				const piggybackUsable =
					!!responseResults?.length &&
					!!this.tryBuildGhostTextExtension(
						sourceSnapshot,
						document,
						responseResults,
					)?.length;
				if (!piggybackUsable) {
					logger.debug(
						`Piggyback unusable for req=${requestId}, originating fresh`,
					);
					sourceSnapshot = requestSnapshot;
					responsePromise = setupOriginate();
					responseResults = await responsePromise;
				}
			}

			if (
				!config.enabled ||
				token.isCancellationRequested ||
				!responseResults?.length
			) {
				return undefined;
			}

			const isOwnRequest = sourceSnapshot === requestSnapshot;
			const isLatestRequest = this.isLatestRequest(requestId);
			let results = responseResults;
			if (!isOwnRequest || !isLatestRequest) {
				const extendedResults = this.tryBuildGhostTextExtension(
					sourceSnapshot,
					document,
					responseResults,
				);
				if (!extendedResults?.length) {
					return undefined;
				}
				results = extendedResults;
			}

			if (
				isOwnRequest &&
				isLatestRequest &&
				this.isRequestStale(requestSnapshot, token)
			) {
				logger.debug("Inline edit response stale; skipping render", {
					uri,
					requestVersion: requestSnapshot.version,
					currentVersion: document.version,
					requestLine: requestSnapshot.position.line,
					requestCharacter: requestSnapshot.position.character,
					contentMatches: requestSnapshot.content === document.getText(),
				});
				return undefined;
			}

			const renderSuppressionReason = await this.getSuppressionReason(document);
			if (renderSuppressionReason) {
				logger.debug(
					"Suppressing inline edit render:",
					renderSuppressionReason,
				);
				return undefined;
			}

			this.clearSuggestionQueue("superseded by fresh response");

			let renderMode: "INLINE" | "JUMP" | null = null;
			const inlineResults: AutocompleteResult[] = [];
			let jumpResult: AutocompleteResult | null = null;

			for (const result of results) {
				const normalizedResult = this.normalizeInlineResult(
					document,
					position,
					result,
				);
				if (!normalizedResult) {
					continue;
				}

				if (this.isNoOpSuggestion(document, normalizedResult)) {
					continue;
				}

				const classification = this.jumpEditManager.classifyEditDisplay(
					document,
					position,
					normalizedResult,
				);
				if (classification.decision === "SUPPRESS") {
					logger.debug("Suppressing suggestion after display classification", {
						reason: classification.reason,
						id: normalizedResult.id,
					});
					continue;
				}

				if (classification.decision === "JUMP") {
					if (!renderMode) {
						renderMode = "JUMP";
						jumpResult = normalizedResult;
					}
					continue;
				}

				if (!renderMode) {
					renderMode = "INLINE";
				}
				if (renderMode === "INLINE") {
					inlineResults.push(normalizedResult);
				}
			}

			if (renderMode === "JUMP" && jumpResult) {
				this.clearSuggestionQueue("jump suggestion takes precedence");
				logger.info("Edit classified as jump edit, showing decoration", {
					id: jumpResult.id,
				});
				this.jumpEditManager.setPendingJumpEdit(document, jumpResult);
				// VSCode keeps a previously-served InlineCompletionItem visible
				// when our provider returns undefined; without this, a stale
				// ghost-text suggestion (possibly from an older buggy build that
				// embedded <|cursor|> in insertText) lingers on top of our jump
				// decoration. Force-hide it so only the JUMP preview is visible.
				void vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
				return undefined;
			}

			if (inlineResults.length === 0) {
				this.jumpEditManager.clearJumpEdit();
				this.clearSuggestionQueue("no renderable inline suggestions");
				return undefined;
			}
			const firstInlineResult = inlineResults[0];
			if (!firstInlineResult) {
				this.jumpEditManager.clearJumpEdit();
				this.clearSuggestionQueue("missing first inline suggestion");
				return undefined;
			}
			this.setSuggestionQueue(uri, inlineResults.slice(1));

			// Clear any stale jump indicator
			this.jumpEditManager.clearJumpEdit();

			logger.info("Rendering inline edit suggestions", {
				count: inlineResults.length,
				cursorLine: position.line,
				firstEditStartLine: document.positionAt(firstInlineResult.startIndex)
					.line,
			});
			return this.buildCompletionItem(document, position, firstInlineResult);
		} catch (error) {
			if ((error as Error).name === "AbortError") {
				return undefined;
			}
			logger.error("InlineEditProvider error:", error);
			return undefined;
		}
	}

	private tryPiggyback(
		uri: string,
		newSnapshot: RequestSnapshot,
	): {
		id: number;
		snapshot: RequestSnapshot;
		response: Promise<AutocompleteResult[] | null>;
	} | null {
		const inFlight = this.inFlightRequest;
		if (!inFlight) return null;
		if (inFlight.uri !== uri) return null;
		if (inFlight.controller.signal.aborted) return null;
		const inserted = this.extractInsertedTextAtCursor(
			inFlight.snapshot.content,
			newSnapshot.content,
			inFlight.snapshot.cursorOffset,
		);
		if (!inserted) return null;
		// Only piggyback for forward typing of identifier characters.
		// Punctuation / whitespace usually mark a syntactic boundary the
		// model's existing prediction won't extend through.
		if (!/^\w+$/.test(inserted)) return null;
		return {
			id: inFlight.id,
			snapshot: inFlight.snapshot,
			response: inFlight.response,
		};
	}

	private cancelInFlightRequest(reason: string): void {
		if (!this.inFlightRequest) return;
		logger.debug("Cancelling in-flight inline edit request:", reason);
		this.inFlightRequest.controller.abort();
		this.inFlightRequest = null;
	}

	private async getSuppressionReason(
		document: vscode.TextDocument,
	): Promise<string | null> {
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) return "no active editor";
		if (activeEditor.document.uri.toString() !== document.uri.toString()) {
			return "inactive document";
		}
		if (!vscode.window.state.focused) return "window not focused";

		if (
			this.hasMultiLineSelection(activeEditor, document) ||
			this.tracker.wasRecentMultiLineSelection(
				document.uri.toString(),
				SELECTION_LOOKBACK_MS,
			)
		) {
			return "multi-line selection";
		}

		const editorTextFocus =
			await this.getContextKeyValue<boolean>("editorTextFocus");
		if (editorTextFocus === false) return "editor not focused";

		const isWritable = vscode.workspace.fs.isWritableFileSystem(
			document.uri.scheme,
		);
		if (isWritable === false) return "read-only document";

		const inSnippetMode =
			await this.getContextKeyValue<boolean>("inSnippetMode");
		if (inSnippetMode) return "snippet/template mode";

		const uri = document.uri.toString();
		if (
			this.tracker.wasRecentBulkChange(uri, {
				windowMs: BULK_CHANGE_LOOKBACK_MS,
				charThreshold: BULK_CHANGE_CHAR_THRESHOLD,
				lineThreshold: BULK_CHANGE_LINE_THRESHOLD,
			})
		) {
			return "recent bulk edit";
		}

		return null;
	}

	private async getContextKeyValue<T>(key: string): Promise<T | undefined> {
		try {
			return (await vscode.commands.executeCommand(
				"getContextKeyValue",
				key,
			)) as T | undefined;
		} catch {
			return undefined;
		}
	}

	private hasMultiLineSelection(
		editor: vscode.TextEditor,
		document: vscode.TextDocument,
	): boolean {
		for (const selection of editor.selections) {
			if (selection.isEmpty) continue;
			if (selection.start.line !== selection.end.line) return true;
			const selectedText = document.getText(selection);
			if (selectedText.includes("\n")) return true;
		}
		return false;
	}

	private async waitForDebounce(
		requestId: number,
		token: vscode.CancellationToken,
	): Promise<boolean> {
		const now = Date.now();
		const elapsed = now - this.lastRequestTimestamp;
		this.lastRequestTimestamp = now;

		const delay = Math.max(0, INLINE_REQUEST_DEBOUNCE_MS - elapsed);
		if (delay === 0) return !token.isCancellationRequested;

		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				disposable.dispose();
				resolve();
			}, delay);
			const disposable = token.onCancellationRequested(() => {
				clearTimeout(timeout);
				disposable.dispose();
				resolve();
			});
		});
		if (token.isCancellationRequested) return false;
		return this.isLatestRequest(requestId);
	}

	private isLatestRequest(requestId: number): boolean {
		return requestId === this.latestRequestId;
	}

	private buildCompletionItem(
		document: vscode.TextDocument,
		position: vscode.Position,
		result: AutocompleteResult,
	): vscode.InlineCompletionList | undefined {
		const cursorOffset = document.offsetAt(position);
		const startPosition = document.positionAt(result.startIndex);
		const endPosition = document.positionAt(result.endIndex);
		const editRange = new vscode.Range(startPosition, endPosition);

		logger.info("Creating inline edit:", {
			id: result.id,
			startPosition: `${startPosition.line}:${startPosition.character}`,
			endPosition: `${endPosition.line}:${endPosition.character}`,
			cursorPosition: `${position.line}:${position.character}`,
			cursorOffset,
			startIndex: result.startIndex,
			endIndex: result.endIndex,
			completionPreview: result.completion.slice(0, 100),
		});
		logger.trace("Creating inline edit completion:", result.completion);

		if (result.startIndex < cursorOffset) {
			logger.debug(
				"Edit before cursor cannot be shown as ghost text; falling back to jump edit",
				{
					id: result.id,
				},
			);
			this.jumpEditManager.setPendingJumpEdit(document, result);
			return undefined;
		}

		if (this.lastInlineEdit?.suggestion.id !== result.id) {
			this.clearInlineEdit("replaced by new inline edit", {
				hideSuggestion: false,
			});
		}

		const acceptedSuggestion: AcceptedInlineSuggestion = {
			id: result.id,
			startIndex: result.startIndex,
			endIndex: result.endIndex,
			completion: result.completion,
		};
		const insertText =
			result.cursorTargetOffset !== undefined
				? toSnippetWithCursor(result.completion, result.cursorTargetOffset)
				: result.completion;
		const item = new vscode.InlineCompletionItem(insertText, editRange);
		item.command = {
			title: "Accept Sweep Inline Edit",
			command: "sweep.acceptInlineEdit",
			arguments: [acceptedSuggestion],
		};

		this.lastInlineEdit = {
			uri: document.uri.toString(),
			line: position.line,
			character: position.character,
			version: document.version,
			suggestion: acceptedSuggestion,
		};
		return { items: [item] };
	}

	async handleCursorMove(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<void> {
		if (
			this.queuedSuggestions &&
			this.queuedSuggestions.uri !== document.uri.toString()
		) {
			this.clearSuggestionQueue("active document changed");
		}

		if (!this.lastInlineEdit) return;
		const currentUri = document.uri.toString();
		if (currentUri !== this.lastInlineEdit.uri) {
			logger.debug("Clearing inline edit: active document changed");
			this.clearInlineEdit("active document changed");
			return;
		}

		if (
			position.line !== this.lastInlineEdit.line ||
			position.character !== this.lastInlineEdit.character ||
			document.version !== this.lastInlineEdit.version
		) {
			if (this.isPrefixTypingExtension(document, position)) {
				return;
			}
			logger.debug("Clearing inline edit: cursor moved away", {
				originalLine: this.lastInlineEdit.line,
				currentLine: position.line,
				originalCharacter: this.lastInlineEdit.character,
				currentCharacter: position.character,
				originalVersion: this.lastInlineEdit.version,
				currentVersion: document.version,
			});
			this.clearInlineEdit("cursor moved away");
		}
	}

	// True when the user is typing forward on the same line and the typed
	// delta is a prefix of the rendered ghost text. Lets VSCode shrink the
	// ghost text in place while the next provider call piggybacks on the
	// in-flight request and extends the suggestion.
	private isPrefixTypingExtension(
		document: vscode.TextDocument,
		position: vscode.Position,
	): boolean {
		const last = this.lastInlineEdit;
		if (!last) return false;
		if (document.uri.toString() !== last.uri) return false;
		if (position.line !== last.line) return false;
		if (position.character <= last.character) return false;
		// Pure-insertion suggestions only — replacements past the cursor
		// would need us to re-derive the visible ghost text after edits.
		if (last.suggestion.startIndex !== last.suggestion.endIndex) return false;

		const anchor = new vscode.Position(last.line, last.character);
		const anchorOffset = document.offsetAt(anchor);
		if (anchorOffset !== last.suggestion.startIndex) return false;

		const newOffset = document.offsetAt(position);
		const typedLen = newOffset - anchorOffset;
		if (typedLen <= 0 || typedLen > last.suggestion.completion.length) {
			return false;
		}
		const typed = document.getText(new vscode.Range(anchor, position));
		return last.suggestion.completion.startsWith(typed);
	}

	handleInlineAccept(acceptedSuggestion?: AcceptedInlineSuggestion): void {
		if (
			acceptedSuggestion &&
			this.lastInlineEdit?.suggestion.id === acceptedSuggestion.id
		) {
			this.lastInlineEdit = null;
		}
		if (!acceptedSuggestion) return;
		this.adjustQueuedSuggestionsAfterAccept(acceptedSuggestion);
		if (this.queuedSuggestions?.suggestions.length) {
			this.shouldConsumeQueuedSuggestion = true;
			void vscode.commands.executeCommand(
				"editor.action.inlineSuggest.trigger",
			);
			return;
		}
		this.clearSuggestionQueue("accepted suggestion exhausted queue");
		// VSCode does not auto-fire the inline-completion provider for the
		// text change that an accept itself applies, so without an explicit
		// trigger we get exactly one suggestion per editing session and then
		// stall until the user types more. cursortab.nvim immediately asks
		// for the next prediction after accept; mirror that here.
		void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
	}

	private clearInlineEdit(
		reason: string,
		options?: { hideSuggestion?: boolean },
	): void {
		if (!this.lastInlineEdit) return;
		const shouldHideSuggestion = options?.hideSuggestion ?? true;

		this.lastInlineEdit = null;
		this.clearSuggestionQueue(reason ? `inline cleared: ${reason}` : undefined);

		if (shouldHideSuggestion) {
			void vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
		}

		if (reason) {
			logger.debug("Inline edit cleared:", reason);
		}
	}

	private setSuggestionQueue(
		uri: string,
		suggestions: AutocompleteResult[],
	): void {
		if (suggestions.length === 0) {
			this.queuedSuggestions = null;
			this.shouldConsumeQueuedSuggestion = false;
			return;
		}
		this.queuedSuggestions = { uri, suggestions: [...suggestions] };
		this.shouldConsumeQueuedSuggestion = false;
	}

	private clearSuggestionQueue(reason?: string): void {
		const hadQueuedSuggestions = this.queuedSuggestions !== null;
		this.queuedSuggestions = null;
		this.shouldConsumeQueuedSuggestion = false;
		if (reason && hadQueuedSuggestions) {
			logger.debug("Cleared queued suggestions:", reason);
		}
	}

	private consumeQueuedSuggestion(
		document: vscode.TextDocument,
		position: vscode.Position,
	): vscode.InlineCompletionList | undefined {
		const queue = this.queuedSuggestions;
		if (!queue || queue.suggestions.length === 0) return undefined;
		const uri = document.uri.toString();
		if (queue.uri !== uri) {
			this.clearSuggestionQueue("active document changed");
			return undefined;
		}

		while (queue.suggestions.length > 0) {
			const next = queue.suggestions.shift();
			if (!next) break;
			const normalized = this.normalizeInlineResult(document, position, next);
			if (!normalized) continue;
			if (this.isNoOpSuggestion(document, normalized)) continue;

			const classification = this.jumpEditManager.classifyEditDisplay(
				document,
				position,
				normalized,
			);
			if (classification.decision === "SUPPRESS") {
				continue;
			}
			if (classification.decision === "JUMP") {
				logger.debug("Rendering queued suggestion as jump edit", {
					id: normalized.id,
					remaining: queue.suggestions.length,
				});
				this.jumpEditManager.setPendingJumpEdit(document, normalized);
				this.shouldConsumeQueuedSuggestion = false;
				return undefined;
			}

			logger.debug("Rendering queued inline edit suggestion", {
				id: normalized.id,
				remaining: queue.suggestions.length,
			});
			this.shouldConsumeQueuedSuggestion = false;
			return this.buildCompletionItem(document, position, normalized);
		}

		this.clearSuggestionQueue("queue exhausted");
		return undefined;
	}

	private adjustQueuedSuggestionsAfterAccept(
		acceptedSuggestion: AcceptedInlineSuggestion,
	): void {
		if (!this.queuedSuggestions?.suggestions.length) return;
		const replacementLength =
			acceptedSuggestion.endIndex - acceptedSuggestion.startIndex;
		const adjustment = acceptedSuggestion.completion.length - replacementLength;
		if (adjustment === 0) return;

		this.queuedSuggestions.suggestions = this.queuedSuggestions.suggestions
			.map((suggestion) => {
				if (suggestion.startIndex < acceptedSuggestion.startIndex) {
					return suggestion;
				}
				return {
					...suggestion,
					startIndex: suggestion.startIndex + adjustment,
					endIndex: suggestion.endIndex + adjustment,
				};
			})
			.filter((suggestion) => suggestion.completion.length > 0);
	}

	private isNoOpSuggestion(
		document: vscode.TextDocument,
		result: AutocompleteResult,
	): boolean {
		const oldContent = document.getText(
			new vscode.Range(
				document.positionAt(result.startIndex),
				document.positionAt(result.endIndex),
			),
		);
		const isNoOp =
			this.trimNewlines(oldContent) === this.trimNewlines(result.completion);
		if (isNoOp) {
			logger.debug(
				"Inline edit response is a no-op after trimming newlines; skipping render",
				{ id: result.id },
			);
		}
		return isNoOp;
	}

	private tryBuildGhostTextExtension(
		snapshot: RequestSnapshot,
		document: vscode.TextDocument,
		results: AutocompleteResult[],
	): AutocompleteResult[] | null {
		const firstResult = results[0];
		if (!firstResult) return null;

		const currentText = document.getText();
		const snapshotCursorOffset = Math.min(
			snapshot.cursorOffset,
			snapshot.content.length,
		);
		const userInsertedText = this.extractInsertedTextAtCursor(
			snapshot.content,
			currentText,
			snapshotCursorOffset,
		);
		if (!userInsertedText) return null;

		const suggestedText =
			snapshot.content.slice(0, firstResult.startIndex) +
			firstResult.completion +
			snapshot.content.slice(firstResult.endIndex);
		const suggestedInsertedText = this.extractInsertedTextAtCursor(
			snapshot.content,
			suggestedText,
			snapshotCursorOffset,
		);
		if (
			!suggestedInsertedText ||
			!suggestedInsertedText.startsWith(userInsertedText)
		) {
			return null;
		}

		const extendedCompletion = suggestedInsertedText.slice(
			userInsertedText.length,
		);
		if (!extendedCompletion) {
			return null;
		}

		const activeEditor = vscode.window.activeTextEditor;
		const currentCursorOffset =
			activeEditor?.document.uri.toString() === snapshot.uri
				? activeEditor.document.offsetAt(activeEditor.selection.active)
				: snapshotCursorOffset + userInsertedText.length;

		const adjustedFirst: AutocompleteResult = {
			...firstResult,
			startIndex: currentCursorOffset,
			endIndex: currentCursorOffset,
			completion: extendedCompletion,
		};
		// userInsertedText was sliced off the front of the completion, so the
		// cursor-target offset (if any) shifts left by the same amount. If it
		// landed inside the consumed prefix it's no longer meaningful — drop it.
		if (firstResult.cursorTargetOffset !== undefined) {
			if (firstResult.cursorTargetOffset >= userInsertedText.length) {
				adjustedFirst.cursorTargetOffset =
					firstResult.cursorTargetOffset - userInsertedText.length;
			} else {
				delete adjustedFirst.cursorTargetOffset;
			}
		}
		const adjustmentOffset = userInsertedText.length;
		const adjustedRemainder = results.slice(1).map((result) => ({
			...result,
			startIndex: result.startIndex + adjustmentOffset,
			endIndex: result.endIndex + adjustmentOffset,
		}));

		logger.debug("Rendering extension from stale inline response", {
			id: adjustedFirst.id,
			adjustmentOffset,
		});

		return [adjustedFirst, ...adjustedRemainder];
	}

	private extractInsertedTextAtCursor(
		originalText: string,
		updatedText: string,
		cursorOffset: number,
	): string | null {
		const prefix = originalText.slice(0, cursorOffset);
		const suffix = originalText.slice(cursorOffset);
		if (!updatedText.startsWith(prefix) || !updatedText.endsWith(suffix)) {
			return null;
		}
		const insertedText = updatedText.slice(
			prefix.length,
			updatedText.length - suffix.length,
		);
		return insertedText.length > 0 ? insertedText : null;
	}

	private buildInput(
		document: vscode.TextDocument,
		position: vscode.Position,
		originalContent: string,
	): AutocompleteInput {
		const maxContextFiles = config.maxContextFiles;

		const recentBuffers = this.buildRecentBuffers(document, maxContextFiles);

		const recentChanges = this.tracker.getEditDiffHistory().map((record) => ({
			path: record.filepath,
			diff: record.diff,
		}));

		const userActions = this.tracker.getUserActions(document.fileName, {
			line: position.line,
			offset: utf8ByteOffsetAt(document, position),
		});

		return {
			document,
			position,
			originalContent,
			recentChanges,
			recentBuffers,
			diagnostics: vscode.languages.getDiagnostics(document.uri),
			userActions,
		};
	}

	private buildRecentBuffers(
		document: vscode.TextDocument,
		maxFiles: number,
	): AutocompleteInput["recentBuffers"] {
		const currentUri = document.uri.toString();
		const buffers: AutocompleteInput["recentBuffers"] = [];
		const seen = new Set<string>();

		const addBuffer = (buffer: AutocompleteInput["recentBuffers"][number]) => {
			if (seen.has(buffer.path)) return;
			seen.add(buffer.path);
			buffers.push(buffer);
		};

		for (const buffer of this.buildVisibleEditorBuffers(currentUri)) {
			addBuffer(buffer);
		}

		const recentFiles = this.tracker.getRecentContextFiles(
			currentUri,
			maxFiles * 2,
		);
		for (const file of recentFiles) {
			const buffer = this.buildBufferFromSnapshot(file);
			if (!buffer) continue;
			addBuffer(buffer);
		}

		return buffers.slice(0, maxFiles);
	}

	private buildVisibleEditorBuffers(
		currentUri: string,
	): AutocompleteInput["recentBuffers"] {
		const buffers: AutocompleteInput["recentBuffers"] = [];

		for (const editor of vscode.window.visibleTextEditors) {
			const document = editor.document;
			if (document.uri.toString() === currentUri) continue;

			const range = this.getPrimaryVisibleRange(editor);
			const focusLine = editor.selection.active.line;
			const chunk = this.buildChunkFromDocument(document, {
				visibleRange: range,
				focusLine,
			});
			if (!chunk) continue;

			buffers.push({
				path: this.getRelativePathForUri(document.uri),
				content: chunk.content,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
			});
		}

		return buffers;
	}

	private getPrimaryVisibleRange(
		editor: vscode.TextEditor,
	): vscode.Range | null {
		const ranges = editor.visibleRanges;
		if (ranges.length === 0) return null;

		const activeLine = editor.selection.active.line;
		const containingRange = ranges.find(
			(range) => activeLine >= range.start.line && activeLine <= range.end.line,
		);
		return containingRange ?? ranges[0] ?? null;
	}

	private buildBufferFromSnapshot(file: {
		filepath: string;
		content: string;
		mtime?: number;
		cursorLine?: number;
	}): AutocompleteInput["recentBuffers"][number] | null {
		if (isFileTooLarge(file.content)) return null;
		const lines = file.content.split("\n");
		const totalLines = lines.length;
		if (totalLines === 0) return null;

		const focusLine = file.cursorLine ?? 0;
		const { startLine, endLine } = this.buildLineWindow(
			0,
			totalLines,
			focusLine,
		);
		const content = lines.slice(startLine, endLine).join("\n");

		return {
			path: file.filepath,
			content,
			startLine,
			endLine,
			...(file.mtime !== undefined ? { mtime: file.mtime } : {}),
		};
	}

	private buildChunkFromDocument(
		document: vscode.TextDocument,
		options: {
			visibleRange: vscode.Range | null;
			focusLine: number;
		},
	): { content: string; startLine: number; endLine: number } | null {
		const totalLines = document.lineCount;
		if (totalLines === 0) return null;

		if (options.visibleRange) {
			const rangeStart = options.visibleRange.start.line;
			const rangeEnd = Math.min(totalLines, options.visibleRange.end.line + 1);
			if (rangeEnd - rangeStart <= MAX_FILE_CHUNK_LINES) {
				return this.buildChunkFromRange(document, rangeStart, rangeEnd);
			}
			const { startLine, endLine } = this.buildLineWindow(
				rangeStart,
				rangeEnd,
				options.focusLine,
			);
			return this.buildChunkFromRange(document, startLine, endLine);
		}

		const { startLine, endLine } = this.buildLineWindow(
			0,
			totalLines,
			options.focusLine,
		);
		return this.buildChunkFromRange(document, startLine, endLine);
	}

	private buildChunkFromRange(
		document: vscode.TextDocument,
		startLine: number,
		endLine: number,
	): { content: string; startLine: number; endLine: number } {
		const clampedStart = Math.max(0, Math.min(startLine, document.lineCount));
		const clampedEnd = Math.max(
			clampedStart,
			Math.min(endLine, document.lineCount),
		);
		const range = new vscode.Range(
			new vscode.Position(clampedStart, 0),
			new vscode.Position(clampedEnd, 0),
		);
		const content = document.getText(range);
		return { content, startLine: clampedStart, endLine: clampedEnd };
	}

	private buildLineWindow(
		minLine: number,
		maxLine: number,
		focusLine: number,
	): { startLine: number; endLine: number } {
		const span = Math.min(MAX_FILE_CHUNK_LINES, maxLine - minLine);
		if (span <= 0) return { startLine: minLine, endLine: minLine };

		const clampedFocus = Math.min(
			Math.max(focusLine, minLine),
			Math.max(minLine, maxLine - 1),
		);
		let startLine = clampedFocus - Math.floor(span / 2);
		startLine = Math.max(minLine, Math.min(startLine, maxLine - span));
		const endLine = startLine + span;
		return { startLine, endLine };
	}

	private getRelativePathForUri(uri: vscode.Uri): string {
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
		if (workspaceFolder) {
			const relativePath = uri.fsPath.slice(
				workspaceFolder.uri.fsPath.length + 1,
			);
			return toUnixPath(relativePath);
		}
		return toUnixPath(uri.fsPath);
	}

	private normalizeInlineResult(
		document: vscode.TextDocument,
		position: vscode.Position,
		result: AutocompleteResult,
	): AutocompleteResult | null {
		const cursorOffset = document.offsetAt(position);

		if (result.startIndex >= cursorOffset)
			return this.trimSuffixOverlap(document, position, result);

		const prefixBeforeCursor = document.getText(
			new vscode.Range(document.positionAt(result.startIndex), position),
		);

		if (!result.completion.startsWith(prefixBeforeCursor)) return result;

		const trimmedCompletion = result.completion.slice(
			prefixBeforeCursor.length,
		);
		if (trimmedCompletion.length === 0) return null;

		const trimmedResult: AutocompleteResult = {
			...result,
			startIndex: cursorOffset,
			endIndex: cursorOffset,
			completion: trimmedCompletion,
		};
		if (result.cursorTargetOffset !== undefined) {
			if (result.cursorTargetOffset >= prefixBeforeCursor.length) {
				trimmedResult.cursorTargetOffset =
					result.cursorTargetOffset - prefixBeforeCursor.length;
			} else {
				delete trimmedResult.cursorTargetOffset;
			}
		}
		return this.trimSuffixOverlap(document, position, trimmedResult);
	}

	private trimSuffixOverlap(
		document: vscode.TextDocument,
		position: vscode.Position,
		result: AutocompleteResult,
	): AutocompleteResult | null {
		if (!result.completion) return null;

		const cursorOffset = document.offsetAt(position);
		const documentLength = document.getText().length;
		const maxLookahead = Math.min(
			documentLength - cursorOffset,
			result.completion.length,
		);
		if (maxLookahead <= 0) return result;

		const followingText = document.getText(
			new vscode.Range(
				position,
				document.positionAt(cursorOffset + maxLookahead),
			),
		);

		let overlap = 0;
		for (let i = maxLookahead; i > 0; i--) {
			if (result.completion.endsWith(followingText.slice(0, i))) {
				overlap = i;
				break;
			}
		}

		if (overlap === 0) return result;

		const trimmedCompletion = result.completion.slice(
			0,
			result.completion.length - overlap,
		);
		if (trimmedCompletion.length === 0) return null;

		const out: AutocompleteResult = {
			...result,
			completion: trimmedCompletion,
		};
		// Drop the cursor target if it landed inside the trimmed suffix.
		if (
			out.cursorTargetOffset !== undefined &&
			out.cursorTargetOffset > trimmedCompletion.length
		) {
			delete out.cursorTargetOffset;
		}
		return out;
	}

	private isRequestStale(
		snapshot: RequestSnapshot,
		token: vscode.CancellationToken,
	): boolean {
		if (token.isCancellationRequested) return true;
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) return true;
		if (!vscode.window.state.focused) return true;
		if (activeEditor.document.uri.toString() !== snapshot.uri) return true;
		if (activeEditor.document.version !== snapshot.version) return true;
		if (activeEditor.document.getText() !== snapshot.content) return true;
		const activePosition = activeEditor.selection.active;
		return (
			activePosition.line !== snapshot.position.line ||
			activePosition.character !== snapshot.position.character
		);
	}

	private trimNewlines(text: string): string {
		return text.replace(/^\n+|\n+$/g, "");
	}
}
