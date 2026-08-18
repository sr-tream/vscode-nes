import * as vscode from "vscode";

import type { ActionType, UserAction } from "~/api/schemas.ts";
import { config } from "~/core/config.ts";
import { shouldCoalesce } from "~/telemetry/edit-merger.ts";
import { formatRecentChangeDiff } from "~/telemetry/unified-diff.ts";
import { toUnixPath } from "~/utils/path.ts";
import { utf8ByteOffsetAt } from "~/utils/text.ts";

// Persistence key in workspaceState. Bumping the suffix retires old
// blobs — load() migrates from LEGACY_STATE_KEY_V1 when present.
const STATE_KEY = "sweep.tracker.v2";
const LEGACY_STATE_KEY_V1 = "sweep.tracker.v1";

// Schemes we treat as real editing surfaces. Everything else — Output
// panel (`output:`), SCM diff editors (`vscode-scm:`), settings.json
// (`vscode-userdata:`), git history views (`git:`), search results,
// notebook scratchpads, etc. — is ignored so it doesn't show up as a
// "recent file" in the prompt (e.g. `<|file_sep|>SR-team.nesweep.NESweep.log`
// when the user peeks at the Output panel).
const TRACKABLE_SCHEMES = new Set(["file", "untitled", "vscode-remote"]);

export function isTrackableDocument(document: vscode.TextDocument): boolean {
	return TRACKABLE_SCHEMES.has(document.uri.scheme);
}

// "Last seen files" context should only ever reference files inside the
// current workspace. Files opened from outside (e.g. a standalone file or a
// path in another project) carry no workspace-relative path and would leak
// absolute filesystem paths into the prompt, so they are excluded.
export function isInWorkspace(uri: vscode.Uri): boolean {
	return vscode.workspace.getWorkspaceFolder(uri) !== undefined;
}

// Save after this much inactivity. Matches the typical LLM prefix-cache
// TTL — once the user has been idle that long, the prior session is
// effectively gone from the server's cache anyway, so capturing the
// snapshot at the same boundary lines up with what's useful as context
// when they come back.
const AFK_DEBOUNCE_MS = 5 * 60 * 1000;

interface FileSnapshot {
	uri: string;
	content: string;
	timestamp: number;
	mtime?: number;
}

interface CursorSnapshot {
	line: number;
	timestamp: number;
}

interface PersistedRecentFile {
	uri: string;
	timestamp: number;
	mtime?: number;
	cursorLine?: number;
}

interface PersistedFileEditBucket {
	filepath: string;
	lastEditTimestamp: number;
	records: EditRecord[];
}

interface PersistedState {
	version: 2;
	savedAt: number;
	recentFileEditBuckets: PersistedFileEditBucket[];
	userActions: UserAction[];
	cursorPositions: Array<[string, CursorSnapshot]>;
	recentFiles: PersistedRecentFile[];
}

// Legacy shape kept around purely so load() can migrate users who still
// have a v1 blob in workspaceState. Drop once everyone has cycled.
interface PersistedStateV1 {
	version: 1;
	savedAt: number;
	editHistory: EditRecord[];
	userActions: UserAction[];
	cursorPositions: Array<[string, CursorSnapshot]>;
	recentFiles: PersistedRecentFile[];
}

interface ChangeSummary {
	timestamp: number;
	totalChars: number;
	totalLines: number;
}

export interface EditRecord {
	filepath: string;
	diff: string;
	timestamp: number;
}

export interface ContextFile {
	filepath: string;
	content: string;
	mtime?: number;
	cursorLine?: number;
}

export class DocumentTracker implements vscode.Disposable {
	private recentFiles = new Map<string, FileSnapshot>();
	private editHistoryByFile = new Map<string, EditRecord[]>();
	private userActions: UserAction[] = [];
	private originalContents = new Map<string, string>();
	private documentContents = new Map<string, string>();
	private cursorPositions = new Map<string, CursorSnapshot>();
	private lastChangeSummaries = new Map<string, ChangeSummary>();
	private lastMultiLineSelections = new Map<string, number>();
	private activeFilepath: string | null = null;
	private maxRecentFiles = 10;
	private maxUserActions = 50;
	// Generous in-memory cap per file; the read-time rebalancer trims
	// further. Persistence layer caps to a smaller K_PERSIST.
	private static readonly INTERNAL_PER_FILE_CAP = 15;
	private static readonly TRACKED_FILES_CAP = 10;
	// Active-file floor: ~20% of TOTAL reserved so a just-reopened file
	// keeps its old edits even when other files have filled the buffer.
	private static readonly ACTIVE_FLOOR_FRAC = 0.2;
	// Share of TOTAL spread across non-active recent files.
	private static readonly OTHERS_SHARE_FRAC = 0.4;
	// Per-file cap at flush time. Smaller than INTERNAL_PER_FILE_CAP so
	// workspaceState stays lean (≤ 50 records across 10 files).
	private static readonly K_PERSIST = 5;
	private context: vscode.ExtensionContext | undefined;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private dirty = false;

	constructor(context?: vscode.ExtensionContext) {
		this.context = context;
		for (const doc of vscode.workspace.textDocuments) {
			if (!isTrackableDocument(doc)) continue;
			this.originalContents.set(doc.uri.toString(), doc.getText());
			this.documentContents.set(doc.uri.toString(), doc.getText());
		}
		if (context) void this.load();
	}

	setActiveFile(document: vscode.TextDocument | null): void {
		if (document && !isTrackableDocument(document)) {
			// Leave the previous active file in place. Switching focus to
			// the Output panel, an SCM diff, settings.json (vscode-userdata),
			// etc. shouldn't drop the real editor's reserved slot.
			return;
		}
		this.activeFilepath = document ? toUnixPath(document.fileName) : null;
	}

	async trackFileVisit(document: vscode.TextDocument): Promise<void> {
		if (!isTrackableDocument(document)) return;
		const uri = document.uri.toString();

		if (!this.originalContents.has(uri)) {
			this.originalContents.set(uri, document.getText());
		}
		this.documentContents.set(uri, document.getText());

		let mtime: number | undefined;
		try {
			const stat = await vscode.workspace.fs.stat(document.uri);
			mtime = Math.floor(stat.mtime / 1000);
		} catch {
			// File may not exist on disk (untitled, etc.)
		}

		if (!isInWorkspace(document.uri)) return;

		const snapshot: FileSnapshot = {
			uri,
			content: document.getText(),
			timestamp: Date.now(),
			...(mtime !== undefined ? { mtime } : {}),
		};
		this.recentFiles.set(uri, snapshot);

		this.pruneRecentFiles();
		this.scheduleSave();
	}

	trackChange(event: vscode.TextDocumentChangeEvent): void {
		if (!isTrackableDocument(event.document)) return;
		const filepath = toUnixPath(event.document.fileName);
		const uri = event.document.uri.toString();
		const now = Date.now();
		const previousDocumentContent = this.documentContents.get(uri);
		let totalChars = 0;
		let totalLines = 0;
		const undoRedoActionType = this.getUndoRedoActionType(event.reason);
		let undoRedoPosition: vscode.Position | null = null;

		for (const change of event.contentChanges) {
			if (!change.text && change.rangeLength === 0) continue;
			const actionPosition = this.getPostChangePosition(event.document, change);

			this.cursorPositions.set(uri, {
				line: actionPosition.line,
				timestamp: now,
			});

			const diff = previousDocumentContent
				? formatRecentChangeDiff({
						filepath,
						previousContent: previousDocumentContent,
						range: change.range,
						rangeOffset: change.rangeOffset,
						rangeLength: change.rangeLength,
						newText: change.text,
					})
				: this.formatDiff(
						filepath,
						change.range,
						change.text,
						change.rangeLength,
					);
			if (diff) {
				this.pushEditRecord({ filepath, diff, timestamp: now });
			}

			if (undoRedoActionType) {
				undoRedoPosition = actionPosition;
			} else {
				const actionType = this.getActionType(change);
				const offset = utf8ByteOffsetAt(event.document, actionPosition);

				this.userActions.push({
					action_type: actionType,
					line_number: actionPosition.line,
					offset,
					file_path: filepath,
					timestamp: now,
				});
				this.pruneUserActions();
			}

			totalChars += change.text.length + change.rangeLength;
			const insertedLines = Math.max(0, change.text.split("\n").length - 1);
			const removedLines = change.range.end.line - change.range.start.line;
			totalLines += insertedLines + removedLines;
		}

		if (totalChars > 0 || totalLines > 0) {
			this.lastChangeSummaries.set(uri, {
				timestamp: now,
				totalChars,
				totalLines,
			});
		}

		if (undoRedoActionType && undoRedoPosition) {
			this.userActions.push({
				action_type: undoRedoActionType,
				line_number: undoRedoPosition.line,
				offset: utf8ByteOffsetAt(event.document, undoRedoPosition),
				file_path: filepath,
				timestamp: now,
			});
			this.pruneUserActions();
		}

		this.documentContents.set(uri, event.document.getText());
		this.scheduleSave();
	}

	trackCursorMovement(
		document: vscode.TextDocument,
		position: vscode.Position,
	): void {
		if (!isTrackableDocument(document)) return;
		const filepath = toUnixPath(document.fileName);
		const offset = utf8ByteOffsetAt(document, position);
		const uri = document.uri.toString();
		const timestamp = Date.now();

		this.cursorPositions.set(uri, {
			line: position.line,
			timestamp,
		});

		this.userActions.push({
			action_type: "CURSOR_MOVEMENT",
			line_number: position.line,
			offset,
			file_path: filepath,
			timestamp,
		});
		this.pruneUserActions();
		this.scheduleSave();
	}

	trackSelectionChange(
		document: vscode.TextDocument,
		selections: readonly vscode.Selection[],
	): void {
		if (!isTrackableDocument(document)) return;
		let hasMultiLine = false;
		for (const selection of selections) {
			if (selection.isEmpty) continue;
			if (selection.start.line !== selection.end.line) {
				hasMultiLine = true;
				break;
			}
		}

		if (hasMultiLine) {
			this.lastMultiLineSelections.set(document.uri.toString(), Date.now());
			this.scheduleSave();
		}
	}

	private getActionType(
		change: vscode.TextDocumentContentChangeEvent,
	): ActionType {
		const isMultiChar = change.text.length > 1 || change.rangeLength > 1;

		if (change.rangeLength > 0 && change.text.length > 0) {
			return isMultiChar ? "INSERT_SELECTION" : "INSERT_CHAR";
		}
		if (change.rangeLength > 0) {
			return isMultiChar ? "DELETE_SELECTION" : "DELETE_CHAR";
		}
		return isMultiChar ? "INSERT_SELECTION" : "INSERT_CHAR";
	}

	private getPostChangePosition(
		document: vscode.TextDocument,
		change: vscode.TextDocumentContentChangeEvent,
	): vscode.Position {
		const insertionEndOffset = change.rangeOffset + change.text.length;
		const documentLength = document.getText().length;
		const clampedOffset = Math.max(
			0,
			Math.min(insertionEndOffset, documentLength),
		);
		return document.positionAt(clampedOffset);
	}

	private getUndoRedoActionType(
		reason: vscode.TextDocumentChangeReason | undefined,
	): Extract<ActionType, "UNDO" | "REDO"> | null {
		if (reason === vscode.TextDocumentChangeReason.Undo) {
			return "UNDO";
		}
		if (reason === vscode.TextDocumentChangeReason.Redo) {
			return "REDO";
		}
		return null;
	}

	getRecentContextFiles(excludeUri: string, maxFiles: number): ContextFile[] {
		return Array.from(this.recentFiles.entries())
			.filter(([uri]) => uri !== excludeUri)
			.sort((a, b) => b[1].timestamp - a[1].timestamp)
			.slice(0, maxFiles)
			.map(([, snapshot]) => {
				const cursor = this.cursorPositions.get(snapshot.uri);
				return {
					filepath: this.getRelativePath(snapshot.uri),
					content: snapshot.content,
					...(snapshot.mtime !== undefined ? { mtime: snapshot.mtime } : {}),
					...(cursor ? { cursorLine: cursor.line } : {}),
				};
			});
	}

	// Read-time rebalancer. Partitions a TOTAL budget across the active
	// file and up to `maxContextFiles` other recent files:
	//   - ACTIVE_FLOOR = ceil(TOTAL * 0.20) is reserved for the active
	//     file (only honoured if it has that many records).
	//   - OTHERS_TOTAL = floor(TOTAL * 0.40) is spread across the top-N
	//     non-active buckets (perOther = floor(OTHERS_TOTAL / N), min 1).
	//   - Remainder fills from the active file's recent activity.
	//   - If the active file under-spends, a round-robin slack pass tops
	//     up from the same top-N other buckets (does not introduce new
	//     files beyond the cap).
	getEditDiffHistory(): EditRecord[] {
		const TOTAL = Math.max(1, config.maxEditHistory);
		const ACTIVE_FLOOR = Math.ceil(TOTAL * DocumentTracker.ACTIVE_FLOOR_FRAC);
		const OTHERS_TOTAL = Math.floor(TOTAL * DocumentTracker.OTHERS_SHARE_FRAC);

		const activeFp = this.activeFilepath;
		const activeBucket = activeFp
			? (this.editHistoryByFile.get(activeFp) ?? [])
			: [];

		const otherBuckets: Array<[string, EditRecord[]]> = [];
		for (const [fp, recs] of this.editHistoryByFile) {
			if (fp === activeFp) continue;
			if (recs.length === 0) continue;
			otherBuckets.push([fp, recs]);
		}
		otherBuckets.sort(
			(a, b) =>
				(b[1][b[1].length - 1]?.timestamp ?? 0) -
				(a[1][a[1].length - 1]?.timestamp ?? 0),
		);

		const maxContextFiles = Math.max(0, config.maxContextFiles);
		const otherFilesCap = Math.min(maxContextFiles, otherBuckets.length);
		const perOther =
			otherFilesCap > 0
				? Math.max(1, Math.floor(OTHERS_TOTAL / otherFilesCap))
				: 0;

		const consumed = new Map<string, number>();
		const picked: EditRecord[] = [];
		const includedBuckets = otherBuckets.slice(0, otherFilesCap);

		for (const [fp, recs] of includedBuckets) {
			const take = Math.min(perOther, recs.length);
			picked.push(...recs.slice(recs.length - take));
			consumed.set(fp, take);
		}

		const othersPicked = picked.length;
		const activeBudget = Math.max(ACTIVE_FLOOR, TOTAL - othersPicked);
		const activeTake = Math.min(activeBudget, activeBucket.length);
		picked.push(...activeBucket.slice(activeBucket.length - activeTake));

		if (picked.length < TOTAL && includedBuckets.length > 0) {
			let progressed = true;
			while (picked.length < TOTAL && progressed) {
				progressed = false;
				for (const [fp, recs] of includedBuckets) {
					if (picked.length >= TOTAL) break;
					const used = consumed.get(fp) ?? 0;
					if (used >= recs.length) continue;
					const idx = recs.length - 1 - used;
					const next = recs[idx];
					if (next === undefined) continue;
					picked.push(next);
					consumed.set(fp, used + 1);
					progressed = true;
				}
			}
		}

		return picked.sort((a, b) => b.timestamp - a.timestamp);
	}

	getUserActions(
		filePath: string,
		currentCursor?: { line: number; offset: number },
	): UserAction[] {
		const normalizedPath = toUnixPath(filePath);
		const actions = this.userActions.filter(
			(a) => a.file_path === normalizedPath,
		);

		if (!currentCursor) {
			return actions;
		}

		const lastAction = actions.at(-1);
		const cursorChanged =
			!lastAction ||
			lastAction.action_type !== "CURSOR_MOVEMENT" ||
			lastAction.line_number !== currentCursor.line ||
			lastAction.offset !== currentCursor.offset;
		if (!cursorChanged) {
			return actions;
		}

		return [
			...actions,
			{
				action_type: "CURSOR_MOVEMENT",
				line_number: currentCursor.line,
				offset: currentCursor.offset,
				file_path: normalizedPath,
				timestamp: Date.now(),
			},
		];
	}

	getOriginalContent(uri: string): string | undefined {
		return this.originalContents.get(uri);
	}

	wasRecentBulkChange(
		uri: string,
		options: {
			windowMs: number;
			charThreshold: number;
			lineThreshold: number;
		},
	): boolean {
		const summary = this.lastChangeSummaries.get(uri);
		if (!summary) return false;
		if (Date.now() - summary.timestamp > options.windowMs) return false;
		return (
			summary.totalChars >= options.charThreshold ||
			summary.totalLines >= options.lineThreshold
		);
	}

	wasRecentMultiLineSelection(uri: string, windowMs: number): boolean {
		const timestamp = this.lastMultiLineSelections.get(uri);
		if (!timestamp) return false;
		return Date.now() - timestamp <= windowMs;
	}

	resetOriginalContent(uri: string, content: string): void {
		this.originalContents.set(uri, content);
	}

	private pushEditRecord(record: EditRecord): void {
		const existing = this.editHistoryByFile.get(record.filepath) ?? [];
		const merged = existing.filter(
			(e) => !shouldCoalesce(e, record, record.timestamp),
		);
		merged.push(record);
		const trimmed =
			merged.length > DocumentTracker.INTERNAL_PER_FILE_CAP
				? merged.slice(-DocumentTracker.INTERNAL_PER_FILE_CAP)
				: merged;
		this.editHistoryByFile.set(record.filepath, trimmed);
		this.pruneEditHistoryByFile();
	}

	private pruneEditHistoryByFile(): void {
		if (this.editHistoryByFile.size <= DocumentTracker.TRACKED_FILES_CAP)
			return;
		// Evict files with the oldest newest-record timestamp.
		const entries = Array.from(this.editHistoryByFile.entries()).sort(
			(a, b) =>
				(b[1][b[1].length - 1]?.timestamp ?? 0) -
				(a[1][a[1].length - 1]?.timestamp ?? 0),
		);
		this.editHistoryByFile = new Map(
			entries.slice(0, DocumentTracker.TRACKED_FILES_CAP),
		);
	}

	private formatDiff(
		filepath: string,
		range: vscode.Range,
		newText: string,
		deletedLength: number,
	): string | null {
		const deletedLines = deletedLength > 0 ? 1 : 0;
		const addedLines = newText ? newText.split("\n").length : 0;

		const lines = [
			`Index: ${filepath}`,
			"===================================================================",
			`@@ -${range.start.line + 1},${deletedLines} +${range.start.line + 1},${addedLines} @@`,
		];

		if (deletedLength > 0) {
			lines.push(`-[deleted ${deletedLength} characters]`);
		}
		if (newText) {
			for (const line of newText.split("\n")) {
				lines.push(`+${line}`);
			}
		}

		return lines.join("\n");
	}

	private getRelativePath(uri: string): string {
		try {
			const parsedUri = vscode.Uri.parse(uri);
			const workspaceFolder = vscode.workspace.getWorkspaceFolder(parsedUri);
			if (workspaceFolder) {
				const relativePath = parsedUri.fsPath.slice(
					workspaceFolder.uri.fsPath.length + 1,
				);
				return toUnixPath(relativePath);
			}
			return toUnixPath(parsedUri.fsPath);
		} catch {
			return uri;
		}
	}

	private pruneRecentFiles(): void {
		if (this.recentFiles.size <= this.maxRecentFiles) return;

		const sorted = Array.from(this.recentFiles.entries()).sort(
			(a, b) => b[1].timestamp - a[1].timestamp,
		);
		this.recentFiles = new Map(sorted.slice(0, this.maxRecentFiles));
	}

	private pruneUserActions(): void {
		if (this.userActions.length > this.maxUserActions) {
			this.userActions = this.userActions.slice(-this.maxUserActions);
		}
	}

	private scheduleSave(): void {
		if (!this.context) return;
		this.dirty = true;
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			void this.flush();
		}, AFK_DEBOUNCE_MS);
	}

	// Synchronously cancel the AFK timer and persist if dirty. Call this
	// from deactivate() so a clean reload doesn't lose the tail of the
	// session that hasn't crossed the 5-min boundary yet.
	async flush(): Promise<void> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (!this.context || !this.dirty) return;
		this.dirty = false;
		const recentFileEditBuckets: PersistedFileEditBucket[] = [];
		for (const [filepath, recs] of this.editHistoryByFile) {
			if (recs.length === 0) continue;
			const persistedRecs =
				recs.length > DocumentTracker.K_PERSIST
					? recs.slice(-DocumentTracker.K_PERSIST)
					: recs;
			const last = persistedRecs[persistedRecs.length - 1];
			if (!last) continue;
			recentFileEditBuckets.push({
				filepath,
				lastEditTimestamp: last.timestamp,
				records: persistedRecs,
			});
		}
		const state: PersistedState = {
			version: 2,
			savedAt: Date.now(),
			recentFileEditBuckets,
			userActions: this.userActions,
			cursorPositions: Array.from(this.cursorPositions.entries()),
			recentFiles: Array.from(this.recentFiles.values()).map((s) => {
				const cursor = this.cursorPositions.get(s.uri);
				return {
					uri: s.uri,
					timestamp: s.timestamp,
					...(s.mtime !== undefined ? { mtime: s.mtime } : {}),
					...(cursor ? { cursorLine: cursor.line } : {}),
				};
			}),
		};
		try {
			await this.context.workspaceState.update(STATE_KEY, state);
		} catch {
			// best-effort
		}
	}

	private async load(): Promise<void> {
		if (!this.context) return;
		let raw: PersistedState | PersistedStateV1 | undefined =
			this.context.workspaceState.get<PersistedState>(STATE_KEY);
		let migratedFromV1 = false;
		if (!raw) {
			const legacy =
				this.context.workspaceState.get<PersistedStateV1>(LEGACY_STATE_KEY_V1);
			if (legacy?.version === 1) {
				raw = legacy;
				migratedFromV1 = true;
			}
		}
		if (!raw) return;
		if (raw.version !== 2 && raw.version !== 1) return;

		if (raw.version === 2 && Array.isArray(raw.recentFileEditBuckets)) {
			for (const bucket of raw.recentFileEditBuckets) {
				if (!bucket || !Array.isArray(bucket.records)) continue;
				if (typeof bucket.filepath !== "string") continue;
				if (bucket.records.length === 0) continue;
				const trimmed =
					bucket.records.length > DocumentTracker.INTERNAL_PER_FILE_CAP
						? bucket.records.slice(-DocumentTracker.INTERNAL_PER_FILE_CAP)
						: bucket.records;
				this.editHistoryByFile.set(bucket.filepath, trimmed);
			}
			this.pruneEditHistoryByFile();
		} else if (raw.version === 1 && Array.isArray(raw.editHistory)) {
			// Migrate flat v1 history into per-file buckets. Records are
			// already chronological (push order). pushEditRecord runs the
			// merger so adjacent same-line records from a typing burst that
			// got persisted mid-window collapse on the way in.
			const sorted = [...raw.editHistory].sort(
				(a, b) => a.timestamp - b.timestamp,
			);
			for (const record of sorted) {
				if (
					!record ||
					typeof record.filepath !== "string" ||
					typeof record.diff !== "string" ||
					typeof record.timestamp !== "number"
				)
					continue;
				this.pushEditRecord(record);
			}
		}

		if (Array.isArray(raw.userActions)) {
			this.userActions = raw.userActions.slice(-this.maxUserActions);
		}
		if (Array.isArray(raw.cursorPositions)) {
			this.cursorPositions = new Map(raw.cursorPositions);
		}

		// Mark dirty so the first AFK debounce (or deactivate flush) writes
		// the migrated v2 blob. Also drop the v1 entry so it doesn't
		// keep getting re-imported on every reload.
		if (migratedFromV1) {
			this.dirty = true;
			try {
				await this.context.workspaceState.update(
					LEGACY_STATE_KEY_V1,
					undefined,
				);
			} catch {
				// best-effort
			}
		}

		if (!Array.isArray(raw.recentFiles)) return;
		// Re-read each recent file from disk so the snapshot reflects the
		// current bytes rather than a stale copy from the previous session.
		// Live trackFileVisit calls win the merge — they run concurrently
		// as tabs are restored and have fresher content.
		const decoder = new TextDecoder();
		for (const entry of raw.recentFiles) {
			if (this.recentFiles.has(entry.uri)) continue;
			try {
				const uri = vscode.Uri.parse(entry.uri);
				if (uri.scheme !== "file") continue;
				if (!isInWorkspace(uri)) continue;
				const stat = await vscode.workspace.fs.stat(uri);
				const bytes = await vscode.workspace.fs.readFile(uri);
				if (this.recentFiles.has(entry.uri)) continue;
				const snapshot: FileSnapshot = {
					uri: entry.uri,
					content: decoder.decode(bytes),
					timestamp: entry.timestamp,
					mtime: Math.floor(stat.mtime / 1000),
				};
				this.recentFiles.set(entry.uri, snapshot);
				if (entry.cursorLine !== undefined) {
					this.cursorPositions.set(entry.uri, {
						line: entry.cursorLine,
						timestamp: entry.timestamp,
					});
				}
			} catch {
				// File gone or unreadable — drop the entry.
			}
		}
		this.pruneRecentFiles();
	}

	dispose(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		this.recentFiles.clear();
		this.editHistoryByFile.clear();
		this.userActions = [];
		this.originalContents.clear();
		this.documentContents.clear();
		this.cursorPositions.clear();
		this.lastChangeSummaries.clear();
		this.lastMultiLineSelections.clear();
		this.activeFilepath = null;
	}
}
