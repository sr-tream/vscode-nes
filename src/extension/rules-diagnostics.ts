// Soft-cap warning for .vscode/nes-<languageId>.md rules files. The
// rules body is wrapped as comments and spliced into the prefix of
// every completion prompt (see api/rules.ts + sweep-prompt.ts). A
// caching-enabled server (llama.cpp with -cpent, vLLM/sglang prefix
// cache) reuses the rules KV across requests, so the steady-state cost
// is mostly the context budget consumed — the per-request prompt-eval
// hit only lands on first request and after each save. We surface
// overflow as a Warning + red background; no truncation, the user
// decides whether to trim.

import * as vscode from "vscode";

import { config } from "~/core/config";

// Matches the on-disk layout enforced by api/rules.ts. Path separators
// are both — Windows fsPath uses backslashes.
const RULES_FILE_RE = /[\\/]\.vscode[\\/]nes-[^\\/]+\.md$/;

function isRulesDoc(doc: vscode.TextDocument): boolean {
	if (doc.uri.scheme !== "file") return false;
	return RULES_FILE_RE.test(doc.uri.fsPath);
}

export class RulesDiagnostics implements vscode.Disposable {
	private collection: vscode.DiagnosticCollection;
	private decoration: vscode.TextEditorDecorationType;
	private overLimit = new Map<string, vscode.Range>();
	private disposables: vscode.Disposable[] = [];

	constructor() {
		this.collection =
			vscode.languages.createDiagnosticCollection("nesweep-rules");
		this.decoration = vscode.window.createTextEditorDecorationType({
			backgroundColor: new vscode.ThemeColor("inputValidation.errorBackground"),
			overviewRulerColor: new vscode.ThemeColor("editorError.foreground"),
			overviewRulerLane: vscode.OverviewRulerLane.Right,
		});

		this.disposables.push(
			this.collection,
			this.decoration,
			vscode.workspace.onDidOpenTextDocument((doc) => this.refresh(doc)),
			vscode.workspace.onDidChangeTextDocument((e) => this.refresh(e.document)),
			vscode.workspace.onDidCloseTextDocument((doc) => this.clear(doc)),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (!e.affectsConfiguration("sweep.rulesMaxChars")) return;
				for (const doc of vscode.workspace.textDocuments) this.refresh(doc);
			}),
			vscode.window.onDidChangeVisibleTextEditors(() =>
				this.applyDecorations(),
			),
		);

		for (const doc of vscode.workspace.textDocuments) this.refresh(doc);
	}

	dispose(): void {
		for (const d of this.disposables) d.dispose();
		this.disposables = [];
		this.overLimit.clear();
	}

	private refresh(doc: vscode.TextDocument): void {
		if (!isRulesDoc(doc)) return;
		const limit = config.rulesMaxChars;
		const text = doc.getText();
		const length = text.length;
		const key = doc.uri.toString();

		if (limit <= 0 || length <= limit) {
			this.collection.delete(doc.uri);
			this.overLimit.delete(key);
			this.applyDecorations();
			return;
		}

		const start = doc.positionAt(limit);
		const end = doc.positionAt(length);
		const range = new vscode.Range(start, end);
		const overBy = length - limit;
		const diag = new vscode.Diagnostic(
			range,
			`NESweep rules: ${length} chars, ${overBy} over limit (${limit}).`,
			vscode.DiagnosticSeverity.Warning,
		);
		diag.source = "NESweep";
		this.collection.set(doc.uri, [diag]);
		this.overLimit.set(key, range);
		this.applyDecorations();
	}

	private clear(doc: vscode.TextDocument): void {
		this.collection.delete(doc.uri);
		this.overLimit.delete(doc.uri.toString());
	}

	private applyDecorations(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			const range = this.overLimit.get(editor.document.uri.toString());
			editor.setDecorations(this.decoration, range ? [range] : []);
		}
	}
}
