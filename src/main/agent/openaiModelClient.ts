/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentMessage, IModelClient, IModelClientConfig, IModelRequest, IModelStreamEvent, IToolSpec, ModelStopReason } from './agentTypes.js';
import { readServerSentEvents } from './sse.js';

// --- Wire shapes (only the fields we read) -------------------------------------

interface IOpenAIToolCallDelta {
	readonly index?: number;
	readonly id?: string;
	readonly function?: { readonly name?: string; readonly arguments?: string };
}

interface IOpenAIUsage {
	readonly prompt_tokens?: number;
	readonly completion_tokens?: number;
}

interface IOpenAIChunk {
	readonly choices?: readonly {
		readonly delta?: { readonly content?: string; readonly reasoning_content?: string; readonly tool_calls?: readonly IOpenAIToolCallDelta[] };
		readonly finish_reason?: string | null;
	}[];
	/** Only present on the trailing chunk when the request set stream_options.include_usage. */
	readonly usage?: IOpenAIUsage;
}

/** A user-turn content part; images ride as data-URL image_url parts. */
type IOpenAIContentPart = { readonly type: 'text'; readonly text: string } | { readonly type: 'image_url'; readonly image_url: { readonly url: string } };

interface IOpenAIMessage {
	readonly role: 'system' | 'user' | 'assistant' | 'tool';
	readonly content: string | null | readonly IOpenAIContentPart[];
	readonly tool_calls?: readonly { readonly id: string; readonly type: 'function'; readonly function: { readonly name: string; readonly arguments: string } }[];
	readonly tool_call_id?: string;
}

// --- Pure translation (unit-tested; no network) --------------------------------

export function toOpenAIMessages(system: string, messages: readonly IAgentMessage[]): IOpenAIMessage[] {
	const wire: IOpenAIMessage[] = [{ role: 'system', content: system }];

	for (const message of messages) {
		if (message.role === 'assistant') {
			let text = '';
			const toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];
			for (const block of message.content) {
				if (block.type === 'text') {
					text += block.text;
				} else if (block.type === 'tool_use') {
					toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } });
				}
			}
			wire.push({ role: 'assistant', content: text.length > 0 ? text : null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) });
			continue;
		}

		// A user turn is either tool results or text (optionally with images).
		let text = '';
		const images: IOpenAIContentPart[] = [];
		for (const block of message.content) {
			if (block.type === 'tool_result') {
				wire.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.content });
			} else if (block.type === 'text') {
				text += block.text;
			} else if (block.type === 'image') {
				images.push({ type: 'image_url', image_url: { url: `data:${block.mediaType};base64,${block.data}` } });
			}
		}
		if (images.length > 0) {
			wire.push({ role: 'user', content: [...images, ...(text.length > 0 ? [{ type: 'text', text } satisfies IOpenAIContentPart] : [])] });
		} else if (text.length > 0) {
			wire.push({ role: 'user', content: text });
		}
	}

	return wire;
}

export function toOpenAITools(tools: readonly IToolSpec[]): { type: 'function'; function: { name: string; description: string; parameters: Readonly<Record<string, unknown>> } }[] {
	return tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
}

export function buildOpenAIRequestBody(config: IModelClientConfig, request: IModelRequest): Record<string, unknown> {
	return {
		model: config.model,
		messages: toOpenAIMessages(request.system, request.messages),
		stream: true,
		// Standard OpenAI field: asks the trailing stream chunk to carry real
		// prompt/completion token counts (ground truth for the context-window
		// meter, in place of the char-count estimate).
		stream_options: { include_usage: true },
		// Explicitly allow several tool calls per turn so the model can batch
		// independent work (reading many files at once) instead of one-per-turn,
		// which otherwise burns through the turn budget. Some OpenAI-compatible
		// providers default this off, so set it rather than rely on the default.
		...(request.tools.length > 0 ? { tools: toOpenAITools(request.tools), parallel_tool_calls: true } : {}),
		...(config.params?.temperature !== undefined ? { temperature: config.params.temperature } : {}),
		...(config.params?.maxTokens !== undefined ? { max_tokens: config.params.maxTokens } : {}),
		...(config.params?.effort ? { reasoning_effort: config.params.effort } : {}),
	};
}

/** Folds streamed chunks into text deltas (now) and tool_use blocks (at the end). */
export class OpenAIStreamAccumulator {
	private readonly toolCalls = new Map<number, { id: string; name: string; args: string }>();
	private readonly order: number[] = [];
	private finishReason: string | undefined;
	private inputTokens: number | undefined;
	private outputTokens: number | undefined;

	push(chunk: unknown): IModelStreamEvent[] {
		const wire = chunk as IOpenAIChunk;
		// With stream_options.include_usage, the trailing chunk carries usage and
		// an EMPTY choices array — read it before the no-choice early return below.
		if (typeof wire.usage?.prompt_tokens === 'number') {
			this.inputTokens = wire.usage.prompt_tokens;
		}
		if (typeof wire.usage?.completion_tokens === 'number') {
			this.outputTokens = wire.usage.completion_tokens;
		}

		const choice = wire.choices?.[0];
		if (!choice) {
			return [];
		}

		if (typeof choice.finish_reason === 'string') {
			this.finishReason = choice.finish_reason;
		}

		const events: IModelStreamEvent[] = [];
		const reasoning = choice.delta?.reasoning_content;
		if (typeof reasoning === 'string' && reasoning.length > 0) {
			events.push({ type: 'thinking_delta', text: reasoning });
		}
		const content = choice.delta?.content;
		if (typeof content === 'string' && content.length > 0) {
			events.push({ type: 'text_delta', text: content });
		}

		for (const call of choice.delta?.tool_calls ?? []) {
			this.accumulateToolCall(call);
		}

		return events;
	}

	finish(): IModelStreamEvent[] {
		const events: IModelStreamEvent[] = [];
		for (const index of this.order) {
			const call = this.toolCalls.get(index);
			if (call) {
				events.push({ type: 'tool_use', block: { type: 'tool_use', id: call.id || `call_${index}`, name: call.name, input: safeJsonParse(call.args) } });
			}
		}

		// prompt_tokens is the ground truth for this turn's prompt size — the
		// renderer uses it as the context-window occupancy reading. Omitted when
		// the provider ignores stream_options.include_usage.
		if (this.inputTokens !== undefined) {
			events.push({ type: 'usage', inputTokens: this.inputTokens, ...(this.outputTokens !== undefined ? { outputTokens: this.outputTokens } : {}) });
		}

		events.push({ type: 'message_stop', stopReason: this.stopReason() });
		return events;
	}

	private accumulateToolCall(delta: IOpenAIToolCallDelta): void {
		const index = delta.index ?? 0;
		let entry = this.toolCalls.get(index);
		if (!entry) {
			entry = { id: '', name: '', args: '' };
			this.toolCalls.set(index, entry);
			this.order.push(index);
		}

		if (delta.id) {
			entry.id = delta.id;
		}
		if (delta.function?.name) {
			entry.name += delta.function.name;
		}
		if (delta.function?.arguments) {
			entry.args += delta.function.arguments;
		}
	}

	private stopReason(): ModelStopReason {
		if (this.order.length > 0) {
			return 'tool_use';
		}

		return this.finishReason === 'length' ? 'max_tokens' : 'end_turn';
	}
}

function safeJsonParse(raw: string): unknown {
	if (raw.trim().length === 0) {
		return {};
	}

	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

// --- Client --------------------------------------------------------------------

export class OpenAIModelClient implements IModelClient {
	constructor(private readonly config: IModelClientConfig) {}

	async *stream(request: IModelRequest): AsyncGenerator<IModelStreamEvent, void> {
		const endpoint = `${this.config.baseURL.replace(/\/$/, '')}/chat/completions`;
		const response = await fetch(endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey ?? ''}` },
			body: JSON.stringify(buildOpenAIRequestBody(this.config, request)),
			signal: request.signal,
		});

		if (!response.ok || !response.body) {
			throw new Error(`OpenAI-compatible request failed: ${response.status} ${await response.text().catch(() => '')}`);
		}

		const accumulator = new OpenAIStreamAccumulator();
		for await (const data of readServerSentEvents(response.body)) {
			if (data === '[DONE]') {
				break;
			}

			let chunk: unknown;
			try {
				chunk = JSON.parse(data);
			} catch {
				continue;
			}

			for (const event of accumulator.push(chunk)) {
				yield event;
			}
		}

		for (const event of accumulator.finish()) {
			yield event;
		}
	}
}
