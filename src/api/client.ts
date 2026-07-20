import { createHash } from "node:crypto";
import * as os from "node:os";
import * as vscode from "vscode";

import { config } from "~/core/config.ts";
import {
	DEFAULT_MAX_RECENT_CHANGES_CHARS,
	MAX_TOKENS,
	TEMPERATURE,
} from "~/core/constants.ts";
import { logger } from "~/core/logger.ts";
import type { CompletionServer } from "~/services/completion-server.ts";
import { toUnixPath } from "~/utils/path.ts";
import {
	isFileTooLarge,
	utf8ByteOffsetAt,
	utf8ByteOffsetToUtf16Offset,
} from "~/utils/text.ts";
import type { CompletionResult } from "./completion-client.ts";
import { detectModelFormat, type ModelPrompt } from "./model-format.ts";
import {
	fuseAndDedupRetrievalSnippets,
	orderRetrievalChunks,
	truncateRetrievalChunk,
} from "./retrieval-chunks.ts";
import { getCommentPrefix, loadWorkspaceRules } from "./rules.ts";
import {
	type AutocompleteRequest,
	AutocompleteRequestSchema,
	type AutocompleteResponse,
	type AutocompleteResult,
	type EditorDiagnostic,
	type FileChunk,
	type RecentBuffer,
	type RecentChange,
	type UserAction,
} from "./schemas.ts";
import { buildSweepResponse } from "./sweep-completion.ts";
import { buildSweepPrompt } from "./sweep-prompt.ts";
import { buildZeta2Response } from "./zeta2-completion.ts";
import { buildZeta2Prompt } from "./zeta2-prompt.ts";

export interface AutocompleteInput {
	document: vscode.TextDocument;
	position: vscode.Position;
	originalContent: string;
	recentChanges: RecentChange[];
	recentBuffers: RecentBuffer[];
	diagnostics: vscode.Diagnostic[];
	userActions: UserAction[];
}

const MAX_RETRIEVAL_CHUNKS = 16;
const MAX_DEFINITION_CHUNKS = 6;
const MAX_USAGE_CHUNKS = 6;
const RETRIEVAL_CONTEXT_LINES_ABOVE = 9;
const RETRIEVAL_CONTEXT_LINES_BELOW = 9;
const MAX_CLIPBOARD_LINES = 20;
const MAX_DIAGNOSTICS = 15;
const RECENT_CHANGE_TRUNCATION_MARKER = "\n...[truncated]\n";
const MIN_TRUNCATED_RECENT_CHANGE_CHARS = 120;

// Per-chunk retrieval truncation. Original Sweep used 200 lines against a
// 150/150 broad window (≈2/3 of the broad-context budget); we keep the same
// ratio so user-tuned sweep.broadBefore/broadAfter scales retrieval too.
function retrievalChunkLines(): number {
	return Math.floor(((config.broadBefore + config.broadAfter) * 2) / 3);
}

export function formatRecentChanges(
	changes: RecentChange[],
	maxChars = DEFAULT_MAX_RECENT_CHANGES_CHARS,
): string {
	const budget = Math.max(0, Math.floor(maxChars));
	if (budget === 0) return "";

	let result = "";
	for (const change of changes) {
		if (!change.diff) continue;

		const cleaned = cleanRecentChangeDiff(change.diff);
		if (!cleaned) continue;

		const header = `File: ${change.path}:\n`;
		const entry = `${header}${cleaned}\n`;
		const remaining = budget - result.length;
		if (remaining <= 0) break;

		if (entry.length <= remaining) {
			result += entry;
			continue;
		}

		if (remaining < MIN_TRUNCATED_RECENT_CHANGE_CHARS) break;
		const truncated = truncateRecentChangeEntry(header, cleaned, remaining);
		if (truncated === "") break;
		result += truncated;
		break;
	}
	return result;
}

function cleanRecentChangeDiff(diff: string): string {
	const lines = diff
		.split("\n")
		.filter(
			(line) =>
				!line.startsWith("Index:") &&
				!line.startsWith("===") &&
				!line.startsWith("---") &&
				!line.startsWith("+++"),
		);
	return lines.join("\n").trim();
}

function truncateRecentChangeEntry(
	header: string,
	body: string,
	maxChars: number,
): string {
	const bodyBudget =
		maxChars - header.length - RECENT_CHANGE_TRUNCATION_MARKER.length;
	if (bodyBudget <= 0) return "";

	let truncated = body.slice(0, bodyBudget);
	const lastNewline = truncated.lastIndexOf("\n");
	if (lastNewline > 0) {
		truncated = truncated.slice(0, lastNewline);
	}
	truncated = truncated.trimEnd();
	if (truncated === "") return "";

	return `${header}${truncated}${RECENT_CHANGE_TRUNCATION_MARKER}`;
}

export class ApiClient {
	private server: CompletionServer;
	private idCounter = 0;
	private readonly identicalPromptResults = new Map<
		string,
		{ completion: CompletionResult; expiresAt: number }
	>();
	private inFlight = 0;
	private readonly processingEmitter = new vscode.EventEmitter<boolean>();
	readonly onDidChangeProcessing = this.processingEmitter.event;

	constructor(server: CompletionServer) {
		this.server = server;
	}

	get isProcessing(): boolean {
		return this.inFlight > 0;
	}

	async getAutocomplete(
		input: AutocompleteInput,
		signal?: AbortSignal,
	): Promise<AutocompleteResult[] | null> {
		const documentText = input.document.getText();
		if (isFileTooLarge(documentText) || isFileTooLarge(input.originalContent)) {
			logger.debug("Skipping autocomplete request: file too large", {
				documentLength: documentText.length,
				originalLength: input.originalContent.length,
			});
			return null;
		}

		const requestData = await this.buildRequest(input);
		const parsedRequest = AutocompleteRequestSchema.safeParse(requestData);
		if (!parsedRequest.success) {
			logger.error("Invalid request data:", parsedRequest.error.message);
			return null;
		}

		const format = detectModelFormat(config.modelName);
		const rules = loadWorkspaceRules(input.document);
		const commentPrefix = getCommentPrefix(input.document.languageId);
		const inlineDiagnosticsMarker = config.inlineDiagnosticsMarker;
		const messageTransforms = config.diagnosticsMessageTransforms;
		const prompt: ModelPrompt =
			format === "zeta2" || format === "zeta2.1"
				? buildZeta2Prompt(parsedRequest.data, {
						diagRadius: config.diagRadius,
						rules,
						commentPrefix,
						injectInlineDiagnostics: config.injectInlineDiagnostics,
						inlineDiagnosticsMarker,
						messageTransforms,
						protocolVersion: format === "zeta2.1" ? "2.1" : "2",
					})
				: buildSweepPrompt(parsedRequest.data, {
						broadBefore: config.broadBefore,
						broadAfter: config.broadAfter,
						diagRadius: config.diagRadius,
						rules,
						commentPrefix,
						injectInlineDiagnostics: config.injectInlineDiagnostics,
						inlineDiagnosticsMarker,
						messageTransforms,
					});

		const reqStarted = Date.now();
		const promptCacheKey = this.getPromptCacheKey(prompt);
		logger.info(
			`→ /v1/completions format=${format} model=${config.modelName} max_tokens=${MAX_TOKENS} prompt_chars=${prompt.prompt.length}`,
		);
		logger.trace("→ /v1/completions raw prompt:", prompt.prompt);
		this.inFlight++;
		if (this.inFlight === 1) this.processingEmitter.fire(true);
		try {
			if (signal?.aborted) return null;
			let completion = config.reuseIdenticalPromptResults
				? this.getIdenticalPromptResult(promptCacheKey)
				: null;
			if (completion) {
				logger.info("↻ reused identical /v1/completions prompt result");
			} else {
				completion = await this.server.getClient().complete(
					{
						model: config.modelName,
						prompt: prompt.prompt,
						temperature: TEMPERATURE,
						maxTokens: MAX_TOKENS,
						stop: prompt.stopTokens,
						timeoutMs: config.completionTimeoutMs,
					},
					signal,
				);
				this.server.reportSuccess();
				if (config.reuseIdenticalPromptResults) {
					this.rememberIdenticalPromptResult(promptCacheKey, completion);
				}
			}
			const elapsed = ((Date.now() - reqStarted) / 1000).toFixed(2);
			logger.info(
				`← /v1/completions ${elapsed}s prompt_eval=${completion.promptEvalCount ?? "?"} eval=${completion.evalCount ?? "?"} finish=${completion.finishReason} response_chars=${completion.text.length}`,
			);
			logger.trace("← /v1/completions raw response:", completion.text);

			const id = `nesweep-${Date.now()}-${++this.idCounter}`;
			let responses: AutocompleteResponse[] | null;
			if (format === "zeta2" || format === "zeta2.1") {
				responses = buildZeta2Response(completion, prompt, id);
			} else {
				const single = buildSweepResponse(completion, prompt, id);
				responses = single ? [single] : null;
			}
			if (!responses) return null;

			const decode = (i: number) =>
				utf8ByteOffsetToUtf16Offset(documentText, i);
			const cursorOffset = input.document.offsetAt(input.position);
			const results: AutocompleteResult[] = [];
			for (const response of responses) {
				const result: AutocompleteResult = {
					id: response.autocomplete_id,
					startIndex: decode(response.start_index),
					endIndex: decode(response.end_index),
					completion: response.completion,
					confidence: response.confidence,
					...(response.cursor_target_offset !== undefined
						? { cursorTargetOffset: response.cursor_target_offset }
						: {}),
				};
				// If the replacement starts before the cursor on the same
				// line that contains it, anchor the start at the cursor and
				// strip the matching prefix from the completion. The
				// InlineEditProvider.normalizeInlineResult path otherwise
				// collapses endIndex onto the cursor when it auto-trims the
				// pre-cursor prefix, leaving the line's original tail
				// (e.g. a stray `)`) in place. Only the primary (cursor)
				// region can ever satisfy the position guard; secondary
				// regions in multi-region 2.1 sit elsewhere in the file.
				if (
					result.startIndex < cursorOffset &&
					cursorOffset <= result.endIndex
				) {
					const prefix = documentText.slice(result.startIndex, cursorOffset);
					if (result.completion.startsWith(prefix)) {
						result.startIndex = cursorOffset;
						result.completion = result.completion.slice(prefix.length);
						if (result.cursorTargetOffset !== undefined) {
							if (result.cursorTargetOffset >= prefix.length) {
								result.cursorTargetOffset -= prefix.length;
							} else {
								delete result.cursorTargetOffset;
							}
						}
					}
				}
				if (result.completion.length === 0) continue;
				results.push(result);
			}
			if (results.length === 0) return null;
			return results;
		} catch (error) {
			const elapsed = ((Date.now() - reqStarted) / 1000).toFixed(2);
			if ((error as Error).name === "AbortError") {
				logger.debug(`← /v1/completions aborted after ${elapsed}s`);
				return null;
			}
			logger.error(
				`← /v1/completions failed after ${elapsed}s:`,
				(error as Error).message,
			);
			this.server.reportFailure();
			return null;
		} finally {
			this.inFlight--;
			if (this.inFlight === 0) this.processingEmitter.fire(false);
		}
	}

	private getPromptCacheKey(prompt: ModelPrompt): string {
		return createHash("sha256")
			.update(
				JSON.stringify({
					model: config.modelName,
					prompt: prompt.prompt,
					temperature: TEMPERATURE,
					maxTokens: MAX_TOKENS,
					stop: prompt.stopTokens,
				}),
			)
			.digest("hex");
	}

	private getIdenticalPromptResult(key: string): CompletionResult | null {
		const entry = this.identicalPromptResults.get(key);
		if (!entry) return null;
		if (entry.expiresAt <= Date.now()) {
			this.identicalPromptResults.delete(key);
			return null;
		}
		return entry.completion;
	}

	private rememberIdenticalPromptResult(
		key: string,
		completion: CompletionResult,
	): void {
		if (this.identicalPromptResults.size >= 32) {
			const oldestKey = this.identicalPromptResults.keys().next().value;
			if (oldestKey) this.identicalPromptResults.delete(oldestKey);
		}
		this.identicalPromptResults.set(key, {
			completion,
			expiresAt: Date.now() + config.identicalPromptCacheTtlMs,
		});
	}

	private async buildRequest(
		input: AutocompleteInput,
	): Promise<AutocompleteRequest> {
		const {
			document,
			position,
			originalContent,
			recentChanges,
			recentBuffers,
			diagnostics,
			userActions,
		} = input;

		const filePath = toUnixPath(document.uri.fsPath) || "untitled";
		const recentChangesText = formatRecentChanges(
			recentChanges,
			config.maxRecentChangesChars,
		);
		const fileChunks = this.buildFileChunks(recentBuffers);
		const retrievalChunks = await this.buildRetrievalChunks(
			document,
			position,
			filePath,
		);
		const editorDiagnostics = this.buildEditorDiagnostics(
			document,
			diagnostics,
			position.line,
		);

		return {
			debug_info: this.getDebugInfo(),
			repo_name: this.getRepoName(document),
			file_path: filePath,
			file_contents: document.getText(),
			original_file_contents: originalContent,
			cursor_position: utf8ByteOffsetAt(document, position),
			recent_changes: recentChangesText,
			changes_above_cursor: true,
			multiple_suggestions: false,
			file_chunks: fileChunks,
			retrieval_chunks: retrievalChunks,
			editor_diagnostics: editorDiagnostics,
			recent_user_actions: userActions,
			use_bytes: true,
		};
	}

	private buildFileChunks(buffers: RecentBuffer[]): FileChunk[] {
		return buffers
			.filter((buffer) => !isFileTooLarge(buffer.content))
			.slice(0, 3)
			.map((buffer) => {
				if (buffer.startLine !== undefined && buffer.endLine !== undefined) {
					return {
						file_path: toUnixPath(buffer.path),
						start_line: buffer.startLine,
						end_line: buffer.endLine,
						content: buffer.content,
						...(buffer.mtime !== undefined ? { timestamp: buffer.mtime } : {}),
					};
				}
				const lines = buffer.content.split("\n");
				const endLine = Math.min(30, lines.length);
				return {
					file_path: toUnixPath(buffer.path),
					start_line: 0,
					end_line: endLine,
					content: lines.slice(0, endLine).join("\n"),
					timestamp: buffer.mtime,
				};
			});
	}

	private async buildRetrievalChunks(
		document: vscode.TextDocument,
		position: vscode.Position,
		currentFilePath: string,
	): Promise<FileChunk[]> {
		const [definitionChunks, usageChunks, clipboardChunks] = await Promise.all([
			this.buildDefinitionChunks(document, position),
			this.buildUsageChunks(document, position),
			config.includeClipboardContext
				? this.buildClipboardChunks()
				: Promise.resolve([]),
		]);

		// Diagnostics are emitted as a structured, distance-filtered section
		// by the prompt builders (sweep-prompt's formatDiagnosticsSection,
		// zeta2-prompt's formatDiagnosticsPseudoFile) using
		// editor_diagnostics. We deliberately don't include them as a
		// retrieval chunk too — that path was unfiltered (file-wide) and
		// duplicated the same data in a less useful position in the prompt.
		const chunks = [...usageChunks, ...definitionChunks, ...clipboardChunks]
			.filter((chunk) => chunk.file_path !== currentFilePath)
			.map((chunk) => truncateRetrievalChunk(chunk, retrievalChunkLines()))
			.filter((chunk) => chunk.content.trim().length > 0);

		const fused = fuseAndDedupRetrievalSnippets(chunks);
		return orderRetrievalChunks(
			fused,
			config.stableRetrievalOrdering,
			MAX_RETRIEVAL_CHUNKS,
		);
	}

	private buildEditorDiagnostics(
		document: vscode.TextDocument,
		diagnostics: vscode.Diagnostic[],
		cursorLine0: number,
	): EditorDiagnostic[] {
		const mapped = diagnostics.map((diagnostic) => {
			const code = extractDiagnosticCode(diagnostic.code);
			return {
				line: diagnostic.range.start.line + 1,
				start_offset: document.offsetAt(diagnostic.range.start),
				end_offset: document.offsetAt(diagnostic.range.end),
				severity: this.formatSeverity(diagnostic.severity),
				message: diagnostic.message,
				timestamp: Date.now(),
				...(code !== undefined ? { code } : {}),
			};
		});

		// If the cursor line itself has an error-severity diagnostic, drop
		// every diagnostic below the cursor. clangd / tsserver routinely
		// emit a swarm of cascading errors ("expected ;", "undeclared
		// identifier 'camera'") downstream of a single root-cause typo;
		// they distract small models from the real fix and waste prompt
		// budget. Above-cursor diagnostics are kept untouched (they may
		// be unrelated real issues).
		const cursorLine1 = cursorLine0 + 1;
		const hasErrorOnCursorLine = mapped.some(
			(d) => d.line === cursorLine1 && d.severity === "error",
		);
		const filtered = hasErrorOnCursorLine
			? mapped.filter((d) => d.line <= cursorLine1)
			: mapped;
		return filtered.slice(0, MAX_DIAGNOSTICS);
	}

	private async buildClipboardChunks(): Promise<FileChunk[]> {
		try {
			const clipboard = (await vscode.env.clipboard.readText()).trim();
			if (!clipboard) return [];

			const lines = clipboard.split(/\r?\n/).slice(0, MAX_CLIPBOARD_LINES);
			const content = lines.join("\n").trim();
			if (!content) return [];

			return [
				{
					file_path: "clipboard.txt",
					start_line: 1,
					end_line: lines.length,
					content,
					timestamp: Date.now(),
				},
			];
		} catch {
			return [];
		}
	}

	private async buildDefinitionChunks(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<FileChunk[]> {
		try {
			const results =
				(await vscode.commands.executeCommand<
					Array<vscode.Location | vscode.LocationLink> | undefined
				>("vscode.executeDefinitionProvider", document.uri, position)) ?? [];
			const locations = results
				.map((result) => this.normalizeLocation(result))
				.filter((location): location is vscode.Location => location !== null);
			return this.buildLocationChunks(locations, MAX_DEFINITION_CHUNKS);
		} catch {
			return [];
		}
	}

	private async buildUsageChunks(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<FileChunk[]> {
		try {
			const results =
				(await vscode.commands.executeCommand<vscode.Location[] | undefined>(
					"vscode.executeReferenceProvider",
					document.uri,
					position,
				)) ?? [];
			return this.buildLocationChunks(results, MAX_USAGE_CHUNKS);
		} catch {
			return [];
		}
	}

	private normalizeLocation(
		location: vscode.Location | vscode.LocationLink,
	): vscode.Location | null {
		if ("uri" in location && "range" in location) {
			return new vscode.Location(location.uri, location.range);
		}
		if ("targetUri" in location && "targetRange" in location) {
			return new vscode.Location(location.targetUri, location.targetRange);
		}
		return null;
	}

	private async buildLocationChunks(
		locations: readonly vscode.Location[],
		maxChunks: number,
	): Promise<FileChunk[]> {
		const seen = new Set<string>();
		const chunks: FileChunk[] = [];

		for (const location of locations) {
			if (chunks.length >= maxChunks) break;
			const key = `${location.uri.toString()}:${location.range.start.line}:${location.range.end.line}`;
			if (seen.has(key)) continue;
			seen.add(key);

			const chunk = await this.buildChunkFromLocation(location);
			if (!chunk) continue;
			chunks.push(chunk);
		}

		return chunks;
	}

	private async buildChunkFromLocation(
		location: vscode.Location,
	): Promise<FileChunk | null> {
		let targetDocument: vscode.TextDocument;
		try {
			targetDocument = await vscode.workspace.openTextDocument(location.uri);
		} catch {
			return null;
		}

		const totalLines = targetDocument.lineCount;
		if (totalLines === 0) return null;

		const startLine = Math.max(
			0,
			location.range.start.line - RETRIEVAL_CONTEXT_LINES_ABOVE,
		);
		const endLine = Math.min(
			totalLines - 1,
			location.range.end.line + RETRIEVAL_CONTEXT_LINES_BELOW,
		);
		const endPosition =
			endLine + 1 < totalLines
				? new vscode.Position(endLine + 1, 0)
				: targetDocument.lineAt(endLine).range.end;
		const range = new vscode.Range(
			new vscode.Position(startLine, 0),
			endPosition,
		);
		const content = targetDocument.getText(range).trim();
		if (!content) return null;

		return {
			file_path:
				toUnixPath(targetDocument.uri.fsPath) || targetDocument.uri.toString(),
			start_line: startLine + 1,
			end_line: endLine + 1,
			content,
			timestamp: Date.now(),
		};
	}

	private formatSeverity(
		severity: vscode.DiagnosticSeverity | undefined,
	): string {
		switch (severity) {
			case vscode.DiagnosticSeverity.Error:
				return "error";
			case vscode.DiagnosticSeverity.Warning:
				return "warning";
			case vscode.DiagnosticSeverity.Information:
				return "info";
			case vscode.DiagnosticSeverity.Hint:
				return "hint";
			default:
				return "info";
		}
	}

	getDebugInfo(): string {
		const extensionVersion =
			vscode.extensions.getExtension("sr-tream.nesweep")?.packageJSON
				?.version ?? "unknown";
		return `VSCode (${vscode.version}) - OS: ${os.platform()} ${os.arch()} - NESweep v${extensionVersion}`;
	}

	private getRepoName(document: vscode.TextDocument): string {
		return (
			vscode.workspace.getWorkspaceFolder(document.uri)?.name || "untitled"
		);
	}
}

function extractDiagnosticCode(
	code: vscode.Diagnostic["code"],
): string | undefined {
	if (code === undefined || code === null) return undefined;
	if (typeof code === "string") return code || undefined;
	if (typeof code === "number") return String(code);
	if (typeof code === "object" && "value" in code) {
		const v = code.value;
		if (typeof v === "string") return v || undefined;
		if (typeof v === "number") return String(v);
	}
	return undefined;
}
