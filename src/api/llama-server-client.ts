// llama.cpp server client. Talks to the OpenAI-compatible
// /v1/completions endpoint. Unlike Ollama's compat layer, llama-server's
// context size is a startup flag (--ctx-size) — there is no per-request
// num_ctx — so numCtx and keepAlive on CompletionRequest are ignored
// here. usage.prompt_tokens / completion_tokens are surfaced as
// promptEvalCount / evalCount so logs stay aligned with the Ollama
// path.

import * as http from "node:http";
import * as https from "node:https";

import type {
	CompletionClient,
	CompletionRequest,
	CompletionResult,
} from "./ollama-client.ts";

interface OpenAICompletionResponse {
	choices?: Array<{
		text?: string;
		finish_reason?: string;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
	};
}

export class LlamaServerClient implements CompletionClient {
	constructor(private readonly baseUrl: string) {}

	async complete(
		req: CompletionRequest,
		signal?: AbortSignal,
	): Promise<CompletionResult> {
		const body = {
			model: req.model,
			prompt: req.prompt,
			temperature: req.temperature,
			max_tokens: req.maxTokens,
			stop: req.stop,
			stream: false,
		};

		const payload = JSON.stringify(body);
		const url = new URL("/v1/completions", this.baseUrl);
		const transport = url.protocol === "https:" ? https : http;
		const port = url.port || (url.protocol === "https:" ? 443 : 80);

		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				cleanup();
				fn();
			};

			const reqOptions: http.RequestOptions = {
				hostname: url.hostname,
				port,
				path: `${url.pathname}${url.search}`,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(payload),
				},
				timeout: req.timeoutMs,
			};

			const httpReq = transport.request(reqOptions, (res) => {
				let data = "";
				res.on("data", (chunk) => {
					data += chunk.toString();
				});
				res.on("end", () => {
					if (res.statusCode !== 200) {
						finish(() =>
							reject(
								new Error(
									`llama-server request failed (${res.statusCode}): ${data}`,
								),
							),
						);
						return;
					}
					try {
						const parsed = JSON.parse(data) as OpenAICompletionResponse;
						const choice = parsed.choices?.[0];
						const result: CompletionResult = {
							text: choice?.text ?? "",
							finishReason: choice?.finish_reason ?? "stop",
						};
						if (parsed.usage?.prompt_tokens !== undefined) {
							result.promptEvalCount = parsed.usage.prompt_tokens;
						}
						if (parsed.usage?.completion_tokens !== undefined) {
							result.evalCount = parsed.usage.completion_tokens;
						}
						finish(() => resolve(result));
					} catch {
						finish(() =>
							reject(new Error("Failed to parse llama-server response")),
						);
					}
				});
			});

			const onError = (error: Error) => {
				finish(() =>
					reject(new Error(`llama-server request error: ${error.message}`)),
				);
			};

			const onTimeout = () => {
				const err = new Error(
					`llama-server request timed out after ${req.timeoutMs}ms`,
				);
				httpReq.destroy(err);
				finish(() => reject(err));
			};

			const onAbort = () => {
				const abortError = new Error("Request aborted");
				abortError.name = "AbortError";
				httpReq.destroy(abortError);
				finish(() => reject(abortError));
			};

			const cleanup = () => {
				httpReq.off("error", onError);
				httpReq.off("timeout", onTimeout);
				if (signal) signal.removeEventListener("abort", onAbort);
			};

			httpReq.on("error", onError);
			httpReq.on("timeout", onTimeout);
			if (signal) {
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort);
			}

			httpReq.write(payload);
			httpReq.end();
		});
	}

	async ping(timeoutMs = 1500): Promise<boolean> {
		return new Promise((resolve) => {
			const url = new URL("/health", this.baseUrl);
			const transport = url.protocol === "https:" ? https : http;
			const port = url.port || (url.protocol === "https:" ? 443 : 80);
			const req = transport.get(
				{
					hostname: url.hostname,
					port,
					path: url.pathname,
					timeout: timeoutMs,
				},
				(res) => {
					res.resume();
					resolve(
						res.statusCode !== undefined &&
							res.statusCode >= 200 &&
							res.statusCode < 500,
					);
				},
			);
			req.on("error", () => resolve(false));
			req.on("timeout", () => {
				req.destroy();
				resolve(false);
			});
		});
	}
}
