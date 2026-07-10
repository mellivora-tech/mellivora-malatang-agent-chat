/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentMessage, IModelClient, IModelClientConfig, IModelRequest, IModelStreamEvent, IToolSpec, ModelStopReason } from './agentTypes.js';
import { readServerSentEvents } from './sse.js';

// max_tokens is a shared budget for thinking + text + tool-call JSON. 4096 was
// enough for text-only replies, but with extended thinking enabled a long
// reasoning stretch can eat the whole budget and leave NO visible text (seen
// live with Kimi: a 17K-char think hit max_tokens before the answer started).
// 32K matches what Claude Code defaults to for current-generation models;
// it is a ceiling, not a target — replies don't get longer or pricier unless
// they genuinely need the room. Override per model via params.maxTokens.
const DEFAULT_MAX_TOKENS = 32_000;
const ANTHROPIC_VERSION = '2023-06-01';

// --- Wire shapes ---------------------------------------------------------------

interface IAnthropicContentBlock {
	readonly type: string;
	readonly text?: string;
	readonly id?: string;
	readonly name?: string;
}

interface IAnthropicUsage {
	readonly input_tokens?: number;
	readonly output_tokens?: number;
	/** Prompt-cache hits/writes — NOT included in input_tokens on this wire format. Kimi's implicit cache reports cache_read too. */
	readonly cache_read_input_tokens?: number;
	readonly cache_creation_input_tokens?: number;
}

interface IAnthropicStreamEvent {
	readonly type: string;
	readonly index?: number;
	readonly content_block?: IAnthropicContentBlock;
	readonly delta?: {
		readonly type?: string;
		readonly text?: string;
		readonly thinking?: string;
		readonly partial_json?: string;
		readonly signature?: string;
		readonly stop_reason?: string;
	};
	/** message_start carries the prompt's usage; message_delta updates output_tokens as it grows. */
	readonly message?: { readonly usage?: IAnthropicUsage };
	readonly usage?: IAnthropicUsage;
}

type AnthropicWireBlock =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
	| { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string; readonly is_error: boolean }
	| { readonly type: 'thinking'; readonly thinking: string; readonly signature?: string }
	| { readonly type: 'image'; readonly source: { readonly type: 'base64'; readonly media_type: string; readonly data: string } };

interface IAnthropicMessage {
	readonly role: 'user' | 'assistant';
	readonly content: readonly AnthropicWireBlock[];
}

// --- Pure translation ----------------------------------------------------------

export function toAnthropicMessages(messages: readonly IAgentMessage[]): IAnthropicMessage[] {
	return messages.map(message => ({
		role: message.role,
		content: message.content.map((block): AnthropicWireBlock => {
			if (block.type === 'text') {
				return { type: 'text', text: block.text };
			}
			if (block.type === 'tool_use') {
				return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
			}
			if (block.type === 'thinking') {
				// Passed back verbatim (signature included) — required by the API in
				// tool-use loops whenever extended thinking is enabled.
				return { type: 'thinking', thinking: block.thinking, ...(block.signature !== undefined ? { signature: block.signature } : {}) };
			}
			if (block.type === 'image') {
				return { type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.data } };
			}
			return { type: 'tool_result', tool_use_id: block.toolUseId, content: block.content, is_error: block.isError };
		}),
	}));
}

export function toAnthropicTools(tools: readonly IToolSpec[]): { name: string; description: string; input_schema: Readonly<Record<string, unknown>> }[] {
	return tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
}

export function buildAnthropicRequestBody(config: IModelClientConfig, request: IModelRequest): Record<string, unknown> {
	return {
		model: config.model,
		max_tokens: config.params?.maxTokens ?? DEFAULT_MAX_TOKENS,
		system: request.system,
		messages: toAnthropicMessages(request.messages),
		stream: true,
		...(request.tools.length > 0 ? { tools: toAnthropicTools(request.tools) } : {}),
		...(config.params?.thinking ? { thinking: { type: 'adaptive' } } : {}),
		...(config.params?.effort ? { output_config: { effort: config.params.effort } } : {}),
	};
}

/** Folds Anthropic stream events into text deltas (now) and tool_use blocks (at the end). */
export class AnthropicStreamAccumulator {
	private readonly blocks = new Map<number, { id: string; name: string; json: string }>();
	private readonly thinking = new Map<number, { text: string; signature?: string }>();
	private readonly order: number[] = [];
	private stopReason: string | undefined;
	private inputTokens: number | undefined;
	private outputTokens: number | undefined;
	private cacheReadTokens: number | undefined;
	private cacheWriteTokens: number | undefined;

	push(event: unknown): IModelStreamEvent[] {
		const wire = event as IAnthropicStreamEvent;
		const index = wire.index ?? 0;

		if (wire.type === 'message_start') {
			const usage = wire.message?.usage;
			if (typeof usage?.input_tokens === 'number') {
				this.inputTokens = usage.input_tokens;
			}
			if (typeof usage?.output_tokens === 'number') {
				this.outputTokens = usage.output_tokens;
			}
			if (typeof usage?.cache_read_input_tokens === 'number') {
				this.cacheReadTokens = usage.cache_read_input_tokens;
			}
			if (typeof usage?.cache_creation_input_tokens === 'number') {
				this.cacheWriteTokens = usage.cache_creation_input_tokens;
			}
			return [];
		}

		if (wire.type === 'content_block_start' && wire.content_block?.type === 'tool_use') {
			this.blocks.set(index, { id: wire.content_block.id ?? '', name: wire.content_block.name ?? '', json: '' });
			this.order.push(index);
			return [];
		}

		if (wire.type === 'content_block_start' && wire.content_block?.type === 'thinking') {
			this.thinking.set(index, { text: '' });
			this.order.push(index);
			return [];
		}

		if (wire.type === 'content_block_delta') {
			if (wire.delta?.type === 'text_delta' && typeof wire.delta.text === 'string' && wire.delta.text.length > 0) {
				return [{ type: 'text_delta', text: wire.delta.text }];
			}
			if (wire.delta?.type === 'thinking_delta' && typeof wire.delta.thinking === 'string' && wire.delta.thinking.length > 0) {
				// The block accumulates for the transcript; the delta streams to the UI.
				const block = this.thinking.get(index);
				if (block) {
					block.text += wire.delta.thinking;
				}
				return [{ type: 'thinking_delta', text: wire.delta.thinking }];
			}
			if (wire.delta?.type === 'signature_delta' && typeof wire.delta.signature === 'string') {
				const block = this.thinking.get(index);
				if (block) {
					block.signature = (block.signature ?? '') + wire.delta.signature;
				}
				return [];
			}
			if (wire.delta?.type === 'input_json_delta' && typeof wire.delta.partial_json === 'string') {
				const block = this.blocks.get(index);
				if (block) {
					block.json += wire.delta.partial_json;
				}
			}
			return [];
		}

		if (wire.type === 'message_delta') {
			if (typeof wire.delta?.stop_reason === 'string') {
				this.stopReason = wire.delta.stop_reason;
			}
			if (typeof wire.usage?.output_tokens === 'number') {
				this.outputTokens = wire.usage.output_tokens;
			}
			return [];
		}

		return [];
	}

	finish(): IModelStreamEvent[] {
		const events: IModelStreamEvent[] = [];
		// Stream order preserved across kinds so the transcript can replay the
		// blocks exactly as the model produced them.
		for (const index of this.order) {
			const thought = this.thinking.get(index);
			if (thought && thought.text.length > 0) {
				events.push({ type: 'thinking_block', block: { type: 'thinking', thinking: thought.text, ...(thought.signature !== undefined ? { signature: thought.signature } : {}) } });
				continue;
			}
			const block = this.blocks.get(index);
			if (block) {
				events.push({ type: 'tool_use', block: { type: 'tool_use', id: block.id, name: block.name, input: safeJsonParse(block.json) } });
			}
		}

		// input_tokens on message_start is the ground truth for this turn's prompt
		// size — the renderer uses it as the context-window occupancy reading.
		if (this.inputTokens !== undefined) {
			events.push({
				type: 'usage',
				inputTokens: this.inputTokens,
				...(this.outputTokens !== undefined ? { outputTokens: this.outputTokens } : {}),
				...(this.cacheReadTokens !== undefined ? { cacheReadTokens: this.cacheReadTokens } : {}),
				...(this.cacheWriteTokens !== undefined ? { cacheWriteTokens: this.cacheWriteTokens } : {}),
			});
		}

		events.push({ type: 'message_stop', stopReason: this.mapStop() });
		return events;
	}

	private mapStop(): ModelStopReason {
		// `order` interleaves thinking and tool blocks — only actual tool calls
		// make this a tool_use stop (a thinking-only turn is a normal end_turn).
		if (this.blocks.size > 0 || this.stopReason === 'tool_use') {
			return 'tool_use';
		}
		if (this.stopReason === 'max_tokens') {
			return 'max_tokens';
		}
		if (this.stopReason === 'refusal') {
			return 'refusal';
		}

		return 'end_turn';
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

export class AnthropicModelClient implements IModelClient {
	constructor(private readonly config: IModelClientConfig) {}

	async *stream(request: IModelRequest): AsyncGenerator<IModelStreamEvent, void> {
		const endpoint = `${this.config.baseURL.replace(/\/$/, '')}/v1/messages`;
		const response = await fetch(endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-api-key': this.config.apiKey ?? '', 'anthropic-version': ANTHROPIC_VERSION },
			body: JSON.stringify(buildAnthropicRequestBody(this.config, request)),
			signal: request.signal,
		});

		if (!response.ok || !response.body) {
			throw new Error(`Anthropic request failed: ${response.status} ${await response.text().catch(() => '')}`);
		}

		const accumulator = new AnthropicStreamAccumulator();
		for await (const data of readServerSentEvents(response.body)) {
			let event: unknown;
			try {
				event = JSON.parse(data);
			} catch {
				continue;
			}

			for (const streamEvent of accumulator.push(event)) {
				yield streamEvent;
			}
		}

		for (const streamEvent of accumulator.finish()) {
			yield streamEvent;
		}
	}
}
