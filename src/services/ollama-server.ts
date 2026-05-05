import * as vscode from "vscode";
import { LlamaServerClient } from "~/api/llama-server-client.ts";
import type { CompletionClient } from "~/api/ollama-client.ts";
import { OllamaClient } from "~/api/ollama-client.ts";
import { config } from "~/core/config.ts";

const MAX_CONSECUTIVE_FAILURES = 3;
const FAILURE_COOLDOWN_MS = 60_000;

export class OllamaServer implements vscode.Disposable {
	private consecutiveFailures = 0;
	private lastWarningAt = 0;
	private warned = false;

	getClient(): CompletionClient {
		if (config.backend === "llama-server") {
			return new LlamaServerClient(config.llamaServerUrl);
		}
		return new OllamaClient(config.ollamaUrl);
	}

	async ensureReachable(): Promise<boolean> {
		const ok = await this.getClient().ping();
		if (!ok) this.warnUnreachable();
		return ok;
	}

	reportSuccess(): void {
		this.consecutiveFailures = 0;
		this.warned = false;
	}

	reportFailure(): void {
		this.consecutiveFailures++;
		if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
			this.warnUnreachable();
			this.consecutiveFailures = 0;
		}
	}

	private warnUnreachable(): void {
		const now = Date.now();
		if (this.warned && now - this.lastWarningAt < FAILURE_COOLDOWN_MS) return;
		this.warned = true;
		this.lastWarningAt = now;
		const message =
			config.backend === "llama-server"
				? `Sweep: llama-server is not reachable at ${config.llamaServerUrl}. ` +
					"Start llama-server with the sweep GGUF loaded."
				: `Sweep: Ollama is not reachable at ${config.ollamaUrl}. ` +
					"Start Ollama and pull the sweep model: " +
					"`ollama pull hf.co/sweepai/sweep-next-edit-1.5b`.";
		vscode.window.showWarningMessage(message);
	}

	dispose(): void {}
}
