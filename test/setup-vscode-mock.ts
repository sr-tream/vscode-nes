import { mock } from "bun:test";

type MockConfiguration = Record<string, unknown>;

function getMockConfiguration(): MockConfiguration {
	return ((
		globalThis as typeof globalThis & { __vscodeMockConfiguration?: unknown }
	).__vscodeMockConfiguration ?? {}) as MockConfiguration;
}

// Stand-in for the `vscode` extension API so tests can import production
// modules (logger, config, document-tracker, …) without the VS Code
// Extension Host. Only stub what production module-load actually
// touches — individual tests can extend via `mock.module` themselves.

const noopChannel = {
	trace: () => {},
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	append: () => {},
	appendLine: () => {},
	clear: () => {},
	show: () => {},
	hide: () => {},
	dispose: () => {},
	name: "NESweep",
	logLevel: 0,
	onDidChangeLogLevel: () => ({ dispose: () => {} }),
	replace: () => {},
};

mock.module("vscode", () => ({
	window: {
		createOutputChannel: () => noopChannel,
		activeTextEditor: undefined,
		onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
		onDidChangeActiveColorTheme: () => ({ dispose: () => {} }),
		onDidChangeTextEditorSelection: () => ({ dispose: () => {} }),
		createTextEditorDecorationType: () => ({ dispose: () => {} }),
		activeColorTheme: { kind: 1 },
	},
	workspace: {
		textDocuments: [],
		workspaceFolders: undefined,
		getConfiguration: () => ({
			get: <T>(key: string, defaultValue?: T) => {
				const value = getMockConfiguration()[key];
				return value === undefined ? defaultValue : (value as T);
			},
			update: () => Promise.resolve(),
			inspect: () => undefined,
		}),
		getWorkspaceFolder: () => undefined,
		onDidChangeTextDocument: () => ({ dispose: () => {} }),
		onDidChangeConfiguration: () => ({ dispose: () => {} }),
		fs: {
			stat: () =>
				Promise.reject(new Error("vscode mock: fs.stat not available")),
			readFile: () =>
				Promise.reject(new Error("vscode mock: fs.readFile not available")),
		},
	},
	languages: {
		registerInlineCompletionItemProvider: () => ({ dispose: () => {} }),
	},
	commands: {
		registerCommand: () => ({ dispose: () => {} }),
		executeCommand: () => Promise.resolve(),
	},
	Uri: {
		parse: (s: string) => ({ scheme: "file", fsPath: s, toString: () => s }),
		file: (s: string) => ({ scheme: "file", fsPath: s, toString: () => s }),
	},
	Range: class {
		constructor(
			public start: unknown,
			public end: unknown,
		) {}
	},
	Position: class {
		constructor(
			public line: number,
			public character: number,
		) {}
	},
	Selection: class {
		constructor(
			public anchor: unknown,
			public active: unknown,
		) {}
	},
	SnippetString: class {
		value: string;
		constructor(value = "") {
			this.value = value;
		}
	},
	InlineCompletionItem: class {
		filterText?: string;
		command?: unknown;
		constructor(
			public insertText: unknown,
			public range?: unknown,
		) {}
	},
	EventEmitter: class {
		event = () => ({ dispose: () => {} });
		fire() {}
		dispose() {}
	},
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
	TextDocumentChangeReason: { Undo: 1, Redo: 2 },
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
	Diagnostic: class {
		constructor(
			public range: unknown,
			public message: string,
			public severity?: number,
		) {}
	},
	StatusBarAlignment: { Left: 1, Right: 2 },
	ThemeColor: class {
		constructor(public id: string) {}
	},
}));
