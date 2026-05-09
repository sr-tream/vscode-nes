import { z } from "zod";

export const FileChunkSchema = z.object({
	file_path: z.string(),
	start_line: z.number(),
	end_line: z.number(),
	content: z.string(),
	timestamp: z.number().optional(),
});

export const UserActionSchema = z.object({
	action_type: z.enum([
		"CURSOR_MOVEMENT",
		"INSERT_CHAR",
		"DELETE_CHAR",
		"INSERT_SELECTION",
		"DELETE_SELECTION",
		"UNDO",
		"REDO",
	]),
	line_number: z.number(),
	offset: z.number(),
	file_path: z.string(),
	timestamp: z.number(),
});

export const EditorDiagnosticSchema = z.object({
	line: z.number(),
	start_offset: z.number(),
	end_offset: z.number(),
	severity: z.string(),
	message: z.string(),
	timestamp: z.number(),
	// Linter-supplied diagnostic code, e.g. clangd's
	// `clang(undeclared_var_use_suggest)` or TS's `2552`. Used as a stable
	// marker in inline `// FIXME[NES, <code>]: <msg>` injections so the
	// response stripper can find them even after the model paraphrases the
	// message text.
	code: z.string().optional(),
});

export const AutocompleteRequestSchema = z.object({
	debug_info: z.string(),
	repo_name: z.string(),
	branch: z.string().optional(),
	file_path: z.string(),
	file_contents: z.string(),
	original_file_contents: z.string(),
	cursor_position: z.number(),
	recent_changes: z.string(),
	changes_above_cursor: z.boolean(),
	multiple_suggestions: z.boolean(),
	file_chunks: z.array(FileChunkSchema),
	retrieval_chunks: z.array(FileChunkSchema),
	editor_diagnostics: z.array(EditorDiagnosticSchema),
	recent_user_actions: z.array(UserActionSchema),
	use_bytes: z.boolean(),
});

export const AutocompleteResponseSchema = z.object({
	autocomplete_id: z.string(),
	start_index: z.number(),
	end_index: z.number(),
	completion: z.string(),
	confidence: z.number(),
	elapsed_time_ms: z.number().optional(),
	finish_reason: z.string().nullable().optional(),
	// UTF-16 code-unit offset inside `completion` where the model placed
	// its cursor-position marker. The provider converts this to a snippet
	// $0 placeholder so accepting drops the cursor at the predicted spot
	// instead of the end of the inserted text.
	cursor_target_offset: z.number().optional(),
	completions: z
		.array(
			z.object({
				autocomplete_id: z.string(),
				start_index: z.number(),
				end_index: z.number(),
				completion: z.string(),
				confidence: z.number(),
			}),
		)
		.optional(),
});

export type FileChunk = z.infer<typeof FileChunkSchema>;
export type UserAction = z.infer<typeof UserActionSchema>;
export type EditorDiagnostic = z.infer<typeof EditorDiagnosticSchema>;
export type AutocompleteRequest = z.infer<typeof AutocompleteRequestSchema>;
export type AutocompleteResponse = z.infer<typeof AutocompleteResponseSchema>;

export type ActionType = UserAction["action_type"];

export interface AutocompleteResult {
	id: string;
	startIndex: number;
	endIndex: number;
	completion: string;
	confidence: number;
	// UTF-16 code-unit offset inside `completion` where the model wants the
	// cursor to land after the suggestion is accepted. Undefined when the
	// model didn't emit a cursor marker.
	cursorTargetOffset?: number;
}

export interface RecentChange {
	path: string;
	diff: string;
}

export interface RecentBuffer {
	path: string;
	content: string;
	mtime?: number;
	startLine?: number;
	endLine?: number;
}
