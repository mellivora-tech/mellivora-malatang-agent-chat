/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentMessage, IModelClient, IModelClientConfig, IModelRequest, IModelStreamEvent, IToolSpec, ModelStopReason } from './agentTypes.js';
import { readServerSentEvents } from './sse.js';

const DEFAULT_MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = '2023-06-01';

// --- Wire shapes ---------------------------------------------------------------

interface IAnthropicContentBlock {
	readonly type: string;
	readonly text?: string;
	readonly id?: string;
	readonly name?: string;
}

interface IAnthropicStreamEvent {
	readonly type: string;
	readonly index?: number;
	readonly content_block?: IAnthropicContentBlock;
	readonly delta?: { readonly type?: string; readonly text?: string; readonly partial_json?: string; readonly stop_reason?: string };
}

type AnthropicWireBlock =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
	| { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string; readonly is_error: boolean };

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
	};
}

/** Folds Anthropic stream events into text deltas (now) and tool_use blocks (at the end). */
export class AnthropicStreamAccumulator {
	private readonly blocks = new Map<number, { id: string; name: string; json: string }>();
	private readonly order: number[] = [];
	private stopReason: string | undefined;

	push(event: unknown): IModelStreamEvent[] {
		const wire = event as IAnthropicStreamEvent;
		const index = wire.index ?? 0;

		if (wire.type === 'content_block_start' && wire.content_block?.type === 'tool_use') {
			this.blocks.set(index, { id: wire.content_block.id ?? '', name: wire.content_block.name ?? '', json: '' });
			this.order.push(index);
			return [];
		}

		if (wire.type === 'content_block_delta') {
			if (wire.delta?.type === 'text_delta' && typeof wire.delta.text === 'string' && wire.delta.text.length > 0) {
				return [{ type: 'text_delta', text: wire.delta.text }];
			}
			if (wire.delta?.type === 'input_json_delta' && typeof wire.delta.partial_json === 'string') {
				const block = this.blocks.get(index);
				if (block) {
					block.json += wire.delta.partial_json;
				}
			}
			return [];
		}

		if (wire.type === 'message_delta' && typeof wire.delta?.stop_reason === 'string') {
			this.stopReason = wire.delta.stop_reason;
		}

		return [];
	}

	finish(): IModelStreamEvent[] {
		const events: IModelStreamEvent[] = [];
		for (const index of this.order) {
			const block = this.blocks.get(index);
			if (block) {
				events.push({ type: 'tool_use', block: { type: 'tool_use', id: block.id, name: block.name, input: safeJsonParse(block.json) } });
			}
		}

		events.push({ type: 'message_stop', stopReason: this.mapStop() });
		return events;
	}

	private mapStop(): ModelStopReason {
		if (this.order.length > 0 || this.stopReason === 'tool_use') {
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
