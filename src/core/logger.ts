// Routes NESweep diagnostics through a vscode.LogOutputChannel.
//
// The channel:
//   - shows up in the Output panel as "NESweep"
//   - is written to disk by VS Code at
//       <userData>/logs/<session>/window<N>/exthost/sr-tream.nesweep/NESweep.log
//   - honours per-channel log level (Command Palette →
//       "Developer: Set Log Level..." → NESweep) which gates trace/debug/info.
//
// Levels we use:
//   error  — exceptions and failed I/O
//   warn   — degraded but recoverable (theme load, missing pending state)
//   info   — coarse milestones (request issued, suggestion rendered, accept)
//   debug  — per-keystroke decisions (default off; opt in via Set Log Level)
//   trace  — heavy payload dumps

import * as vscode from "vscode";

let channel: vscode.LogOutputChannel | undefined;

export function initLogger(): vscode.LogOutputChannel {
	if (!channel) {
		channel = vscode.window.createOutputChannel("NESweep", { log: true });
	}
	return channel;
}

export function disposeLogger(): void {
	channel?.dispose();
	channel = undefined;
}

function fmt(args: unknown[]): string {
	return args
		.map((arg) => {
			if (typeof arg === "string") return arg;
			if (arg instanceof Error) return arg.stack ?? arg.message;
			try {
				return JSON.stringify(arg);
			} catch {
				return String(arg);
			}
		})
		.join(" ");
}

export const logger = {
	trace(...args: unknown[]): void {
		channel?.trace(fmt(args));
	},
	debug(...args: unknown[]): void {
		channel?.debug(fmt(args));
	},
	info(...args: unknown[]): void {
		channel?.info(fmt(args));
	},
	warn(...args: unknown[]): void {
		channel?.warn(fmt(args));
	},
	error(...args: unknown[]): void {
		channel?.error(fmt(args));
	},
};
