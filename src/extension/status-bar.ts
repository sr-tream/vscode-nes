import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { getRulesFilePath } from "~/api/rules.ts";
import { config } from "~/core/config";
import type { CompletionServer } from "~/services/completion-server.ts";

export class SweepStatusBar implements vscode.Disposable {
	private statusBarItem: vscode.StatusBarItem;
	private disposables: vscode.Disposable[] = [];

	constructor(_context: vscode.ExtensionContext) {
		this.statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			100,
		);
		this.statusBarItem.command = "sweep.showMenu";
		this.updateStatusBar();

		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (
					e.affectsConfiguration("sweep.enabled") ||
					e.affectsConfiguration("sweep.autocompleteSnoozeUntil")
				) {
					this.updateStatusBar();
				}
			}),
		);

		this.statusBarItem.show();
	}

	private updateStatusBar(): void {
		const isEnabled = config.enabled;
		const isSnoozed = config.isAutocompleteSnoozed();

		this.statusBarItem.text = "$(sweep-icon) NESweep";
		this.statusBarItem.tooltip = this.buildTooltip(isEnabled, isSnoozed);

		if (!isEnabled || isSnoozed) {
			this.statusBarItem.backgroundColor = new vscode.ThemeColor(
				"statusBarItem.warningBackground",
			);
		} else {
			this.statusBarItem.backgroundColor = undefined;
		}
	}

	private buildTooltip(isEnabled: boolean, isSnoozed: boolean): string {
		const status = isEnabled ? "Enabled" : "Disabled";
		const snoozeUntil = config.autocompleteSnoozeUntil;
		const snoozeLine = isSnoozed
			? `Snoozed Until: ${formatSnoozeTime(snoozeUntil)}`
			: "Snoozed: Off";
		return `NESweep\nStatus: ${status}\n${snoozeLine}\n\nClick to open menu`;
	}

	dispose(): void {
		this.statusBarItem.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}
}

export function registerStatusBarCommands(
	_context: vscode.ExtensionContext,
	completionServer?: CompletionServer,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	disposables.push(
		vscode.commands.registerCommand("sweep.showMenu", async () => {
			const isEnabled = config.enabled;
			const isSnoozed = config.isAutocompleteSnoozed();

			interface MenuItem extends vscode.QuickPickItem {
				action: string;
			}

			const items: MenuItem[] = [
				{
					label: `$(${isEnabled ? "check" : "circle-outline"}) Autocomplete`,
					description: isEnabled ? "Enabled" : "Disabled",
					action: "toggleEnabled",
				},
				{
					label: isSnoozed
						? "$(play-circle) Resume Autocomplete"
						: "$(clock) Snooze Autocomplete",
					description: isSnoozed
						? "Resume suggestions immediately"
						: "Pause suggestions temporarily",
					action: isSnoozed ? "resumeSnooze" : "snooze",
				},
				{
					label: "$(plug) Check Server Connection",
					description: `Ping ${config.serverUrl}`,
					action: "checkBackend",
				},
			];

			const editor = vscode.window.activeTextEditor;
			const rulesPath = editor ? getRulesFilePath(editor.document) : null;
			if (editor && rulesPath) {
				const lang = editor.document.languageId;
				const limit = config.rulesMaxChars;
				let description: string;
				let overflow = false;
				try {
					const stat = fs.statSync(rulesPath);
					const size = stat.size;
					overflow = limit > 0 && size > limit;
					description = overflow
						? `${path.basename(rulesPath)} — ${size} chars (${size - limit} over)`
						: `${path.basename(rulesPath)} — ${size} chars`;
				} catch {
					description = `No instructions yet — click to create ${path.basename(rulesPath)}`;
				}
				items.push({
					label: `$(${overflow ? "warning" : "edit"}) Edit Instructions for ${lang}`,
					description,
					action: "editInstructions",
				});
			}

			const selection = await vscode.window.showQuickPick(items, {
				placeHolder: "NESweep Settings",
				title: "NESweep",
			});

			if (selection) {
				switch (selection.action) {
					case "toggleEnabled":
						await vscode.commands.executeCommand("sweep.toggleEnabled");
						break;
					case "snooze":
						await handleSnooze();
						break;
					case "resumeSnooze":
						await handleResumeSnooze();
						break;
					case "checkBackend":
						if (completionServer) {
							const ok = await completionServer.ensureReachable();
							if (ok) {
								vscode.window.showInformationMessage(
									`NESweep server reachable at ${config.serverUrl}.`,
								);
							}
						}
						break;
					case "editInstructions":
						if (rulesPath) await openRulesFile(rulesPath);
						break;
				}
			}
		}),
	);

	disposables.push(
		vscode.commands.registerCommand("sweep.toggleEnabled", async () => {
			const inspection = config.inspect<boolean>("enabled");
			const current =
				inspection?.workspaceValue ??
				inspection?.globalValue ??
				inspection?.defaultValue ??
				true;
			await config.setEnabled(!current);

			// Hide any existing inline suggestions when disabling
			if (current) {
				await vscode.commands.executeCommand(
					"editor.action.inlineSuggest.hide",
				);
			}

			vscode.window.showInformationMessage(
				`NESweep autocomplete ${!current ? "enabled" : "disabled"}`,
			);
		}),
	);

	return disposables;
}

function formatSnoozeTime(timestamp: number): string {
	return new Date(timestamp).toLocaleString();
}

async function handleSnooze(): Promise<void> {
	const options: Array<{ label: string; minutes: number }> = [
		{ label: "15 minutes", minutes: 15 },
		{ label: "30 minutes", minutes: 30 },
		{ label: "1 hour", minutes: 60 },
		{ label: "4 hours", minutes: 240 },
	];

	const selection = await vscode.window.showQuickPick(
		options.map((option) => ({
			label: option.label,
			description: `Pause autocomplete for ${option.label}`,
		})),
		{ title: "Snooze NESweep Autocomplete", placeHolder: "Choose duration" },
	);

	if (!selection) return;

	const selected = options.find((option) => option.label === selection.label);
	if (!selected) return;

	const until = Date.now() + selected.minutes * 60 * 1000;
	await config.setAutocompleteSnoozeUntil(
		until,
		vscode.ConfigurationTarget.Global,
	);
	await vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
	vscode.window.showInformationMessage(
		`NESweep autocomplete snoozed until ${formatSnoozeTime(until)}.`,
	);
}

async function handleResumeSnooze(): Promise<void> {
	await config.setAutocompleteSnoozeUntil(0, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage("NESweep autocomplete resumed.");
}

async function openRulesFile(rulesPath: string): Promise<void> {
	if (!fs.existsSync(rulesPath)) {
		fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
		fs.writeFileSync(rulesPath, "");
	}
	const doc = await vscode.workspace.openTextDocument(rulesPath);
	await vscode.window.showTextDocument(doc);
}
