import * as os from "node:os";
import * as vscode from "vscode";

import { config } from "~/core/config.ts";
import { MAX_TOKENS, STOP_TOKENS, TEMPERATURE } from "~/core/constants.ts";
import { logger } from "~/core/logger.ts";
import type { CompletionServer } from "~/services/completion-server.ts";
import { toUnixPath } from "~/utils/path.ts";
import {
	isFileTooLarge,
	utf8ByteOffsetAt,
	utf8ByteOffsetToUtf16Offset,
} from "~/utils/text.ts";
import {
	fuseAndDedupRetrievalSnippets,
	truncateRetrievalChunk,
} from "./retrieval-chunks.ts";
import { loadWorkspaceRules } from "./rules.ts";
import {
	type AutocompleteRequest,
	AutocompleteRequestSchema,
	type AutocompleteResult,
	type EditorDiagnostic,
	type FileChunk,
	type RecentBuffer,
	type RecentChange,
	type UserAction,
} from "./schemas.ts";
import { buildAutocompleteResponse } from "./sweep-completion.ts";
import { buildSweepPrompt } from "./sweep-prompt.ts";

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

// Per-chunk retrieval truncation. Original Sweep used 200 lines against a
// 150/150 broad window (≈2/3 of the broad-context budget); we keep the same
// ratio so user-tuned sweep.broadBefore/broadAfter scales retrieval too.
function retrievalChunkLines(): number {
	return Math.floor(((config.broadBefore + config.broadAfter) * 2) / 3);
}

export class ApiClient {
	private server: CompletionServer;
	private idCounter = 0;

	constructor(server: CompletionServer) {
		this.server = server;
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

		const prompt = buildSweepPrompt(parsedRequest.data, {
			broadBefore: config.broadBefore,
			broadAfter: config.broadAfter,
			diagRadius: config.diagRadius,
			rules: loadWorkspaceRules(input.document),
		});

		const reqStarted = Date.now();
		logger.info(
			`→ /v1/completions model=${config.modelName} max_tokens=${MAX_TOKENS} prompt_chars=${prompt.prompt.length}`,
		);
		try {
			const completion = await this.server.getClient().complete(
				{
					model: config.modelName,
					prompt: prompt.prompt,
					temperature: TEMPERATURE,
					maxTokens: MAX_TOKENS,
					stop: STOP_TOKENS,
					timeoutMs: config.completionTimeoutMs,
				},
				signal,
			);
			this.server.reportSuccess();
			const elapsed = ((Date.now() - reqStarted) / 1000).toFixed(2);
			logger.info(
				`← /v1/completions ${elapsed}s prompt_eval=${completion.promptEvalCount ?? "?"} eval=${completion.evalCount ?? "?"} finish=${completion.finishReason} response_chars=${completion.text.length}`,
			);
			logger.trace("← /v1/completions raw response:", completion.text);

			const id = `sweep-${Date.now()}-${++this.idCounter}`;
			const response = buildAutocompleteResponse(completion, prompt, id);
			if (!response) return null;

			const decode = (i: number) =>
				utf8ByteOffsetToUtf16Offset(documentText, i);
			const result: AutocompleteResult = {
				id: response.autocomplete_id,
				startIndex: decode(response.start_index),
				endIndex: decode(response.end_index),
				completion: response.completion,
				confidence: response.confidence,
			};
			// If the replacement starts before the cursor on the same line that
			// contains it, anchor the start at the cursor and strip the matching
			// prefix from the completion. InlineEditProvider.normalizeInlineResult
			// otherwise collapses endIndex onto the cursor when it auto-trims the
			// pre-cursor prefix, leaving the line's original tail (e.g. a stray
			// `)`) in place.
			const cursorOffset = input.document.offsetAt(input.position);
			if (result.startIndex < cursorOffset && cursorOffset <= result.endIndex) {
				const prefix = documentText.slice(result.startIndex, cursorOffset);
				if (result.completion.startsWith(prefix)) {
					result.startIndex = cursorOffset;
					result.completion = result.completion.slice(prefix.length);
				}
			}
			if (result.completion.length === 0) return null;
			return [result];
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
		}
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
		const recentChangesText = this.formatRecentChanges(recentChanges);
		const fileChunks = this.buildFileChunks(recentBuffers);
		const retrievalChunks = await this.buildRetrievalChunks(
			document,
			position,
			filePath,
			diagnostics,
		);
		const editorDiagnostics = this.buildEditorDiagnostics(
			document,
			diagnostics,
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

	private formatRecentChanges(changes: RecentChange[]): string {
		let result = "";
		for (const change of changes) {
			if (!change.diff) continue;

			const lines = change.diff
				.split("\n")
				.filter(
					(line) =>
						!line.startsWith("Index:") &&
						!line.startsWith("===") &&
						!line.startsWith("---") &&
						!line.startsWith("+++"),
				);
			const cleaned = lines.join("\n").trim();
			if (cleaned) {
				result += `File: ${change.path}:\n${cleaned}\n`;
			}
		}
		return result;
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
		diagnostics: vscode.Diagnostic[],
	): Promise<FileChunk[]> {
		const [definitionChunks, usageChunks, clipboardChunks] = await Promise.all([
			this.buildDefinitionChunks(document, position),
			this.buildUsageChunks(document, position),
			this.buildClipboardChunks(),
		]);

		const chunks = [
			...this.buildDiagnosticsTextChunk(currentFilePath, diagnostics),
			...clipboardChunks,
			...usageChunks,
			...definitionChunks,
		]
			.filter((chunk) => chunk.file_path !== currentFilePath)
			.map((chunk) => truncateRetrievalChunk(chunk, retrievalChunkLines()))
			.filter((chunk) => chunk.content.trim().length > 0);

		return fuseAndDedupRetrievalSnippets(chunks).slice(-MAX_RETRIEVAL_CHUNKS);
	}

	private buildDiagnosticsTextChunk(
		filePath: string,
		diagnostics: vscode.Diagnostic[],
	): FileChunk[] {
		if (diagnostics.length === 0) return [];

		let content = "";
		const limitedDiagnostics = diagnostics.slice(0, MAX_DIAGNOSTICS);
		for (const d of limitedDiagnostics) {
			const severity = this.formatSeverity(d.severity);
			const line = d.range.start.line + 1;
			const col = d.range.start.character + 1;
			content += `${filePath}:${line}:${col}: ${severity}: ${d.message}\n`;
		}

		return [
			{
				file_path: "diagnostics",
				start_line: 1,
				end_line: limitedDiagnostics.length,
				content,
			},
		];
	}

	private buildEditorDiagnostics(
		document: vscode.TextDocument,
		diagnostics: vscode.Diagnostic[],
	): EditorDiagnostic[] {
		return diagnostics.slice(0, MAX_DIAGNOSTICS).map((diagnostic) => ({
			line: diagnostic.range.start.line + 1,
			start_offset: document.offsetAt(diagnostic.range.start),
			end_offset: document.offsetAt(diagnostic.range.end),
			severity: this.formatSeverity(diagnostic.severity),
			message: diagnostic.message,
			timestamp: Date.now(),
		}));
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
