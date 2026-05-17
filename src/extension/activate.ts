import * as vscode from "vscode";

import { ApiClient } from "~/api/client.ts";
import { disposeLogger, initLogger, logger } from "~/core/logger.ts";
import { InlineEditProvider } from "~/editor/inline-edit-provider.ts";
import { JumpEditManager } from "~/editor/jump-edit-manager.ts";
import {
	initSyntaxHighlighter,
	reloadTheme,
} from "~/editor/syntax-highlight-renderer.ts";
import { RulesDiagnostics } from "~/extension/rules-diagnostics.ts";
import {
	registerStatusBarCommands,
	SweepStatusBar,
} from "~/extension/status-bar.ts";
import { CompletionServer } from "~/services/completion-server.ts";
import { DocumentTracker } from "~/telemetry/document-tracker.ts";

let tracker: DocumentTracker;
let jumpEditManager: JumpEditManager;
let provider: InlineEditProvider;
let statusBar: SweepStatusBar;
let completionServer: CompletionServer;

export function activate(context: vscode.ExtensionContext) {
	const logChannel = initLogger();
	logger.info("NESweep activated");
	initSyntaxHighlighter();

	tracker = new DocumentTracker();
	completionServer = new CompletionServer();
	const apiClient = new ApiClient(completionServer);
	jumpEditManager = new JumpEditManager();
	provider = new InlineEditProvider(tracker, jumpEditManager, apiClient);
	const refreshTheme = () => {
		reloadTheme();
		jumpEditManager.refreshJumpEditDecorations();
	};

	const providerDisposable =
		vscode.languages.registerInlineCompletionItemProvider(
			{ pattern: "**/*" },
			provider,
		);

	const triggerCommand = vscode.commands.registerCommand(
		"sweep.triggerNextEdit",
		() => {
			vscode.commands.executeCommand("editor.action.inlineEdit.trigger");
		},
	);

	const acceptJumpEditCommand = vscode.commands.registerCommand(
		"sweep.acceptJumpEdit",
		() => jumpEditManager.acceptJumpEdit(),
	);

	const acceptInlineEditCommand = vscode.commands.registerCommand(
		"sweep.acceptInlineEdit",
		(
			acceptedSuggestion:
				| {
						id: string;
						startIndex: number;
						endIndex: number;
						completion: string;
				  }
				| undefined,
		) => {
			provider.handleInlineAccept(acceptedSuggestion);
		},
	);

	const dismissJumpEditCommand = vscode.commands.registerCommand(
		"sweep.dismissJumpEdit",
		() => jumpEditManager.dismissJumpEdit(),
	);

	statusBar = new SweepStatusBar(context);
	const statusBarCommands = registerStatusBarCommands(
		context,
		completionServer,
	);
	const rulesDiagnostics = new RulesDiagnostics();

	const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
		if (event.document === vscode.window.activeTextEditor?.document) {
			tracker.trackChange(event);
		}
	});

	const themeChangeListener = vscode.window.onDidChangeActiveColorTheme(() => {
		refreshTheme();
	});
	const themeConfigListener = vscode.workspace.onDidChangeConfiguration(
		(event) => {
			if (!event.affectsConfiguration("workbench.colorTheme")) return;
			// The colorTheme setting can update slightly after the active theme event.
			setTimeout(() => {
				refreshTheme();
			}, 0);
		},
	);

	const handleCursorMove = (editor: vscode.TextEditor): void => {
		void provider.handleCursorMove(editor.document, editor.selection.active);
		jumpEditManager.handleCursorMove(editor.selection.active);
	};

	const editorChangeListener = vscode.window.onDidChangeActiveTextEditor(
		(editor) => {
			if (editor) {
				tracker.trackFileVisit(editor.document);
				handleCursorMove(editor);
			}
		},
	);

	const selectionChangeListener = vscode.window.onDidChangeTextEditorSelection(
		(event) => {
			if (event.textEditor === vscode.window.activeTextEditor) {
				tracker.trackSelectionChange(
					event.textEditor.document,
					event.selections,
				);
				for (const selection of event.selections) {
					tracker.trackCursorMovement(
						event.textEditor.document,
						selection.active,
					);
				}
				handleCursorMove(event.textEditor);
			}
		},
	);

	if (vscode.window.activeTextEditor) {
		tracker.trackFileVisit(vscode.window.activeTextEditor.document);
		handleCursorMove(vscode.window.activeTextEditor);
	}

	context.subscriptions.push(
		providerDisposable,
		triggerCommand,
		acceptJumpEditCommand,
		acceptInlineEditCommand,
		dismissJumpEditCommand,
		changeListener,
		editorChangeListener,
		selectionChangeListener,
		themeChangeListener,
		themeConfigListener,
		tracker,
		jumpEditManager,
		statusBar,
		completionServer,
		rulesDiagnostics,
		logChannel,
		...statusBarCommands,
	);

	// Probe the completion server once at startup so the user gets an early
	// warning if it's down or the URL is wrong; the actual model load is
	// deferred to the first completion.
	void completionServer.ensureReachable();
}

export function deactivate() {
	disposeLogger();
}
