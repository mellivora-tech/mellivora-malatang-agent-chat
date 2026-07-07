/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentEvent, IAgentMessage, IAgentRunConfig, IAgentTerminal, IContentBlock, IModelRequest, IToolUseBlock, ModelStopReason } from './agentTypes.js';
import { toolSpec } from './agentTools.js';
import { executeToolUses } from './toolRunner.js';

const DEFAULT_MAX_TURNS = 50;

/**
 * The harness. A single `async function*` driving a `while (true)` loop:
 *
 *   stream the model → accumulate the assistant message → detect tool_use →
 *   run the tools (serial, fail-closed gate) → append tool_results → repeat.
 *
 * The turn ends when an assistant message contains no tool_use block — the
 * continuation signal is the presence of a tool call, NOT the model's
 * `stop_reason` (which Claude Code notes is unreliable). Consumers iterate the
 * yielded {@link IAgentEvent}s and read the returned {@link IAgentTerminal}.
 */
export async function* runAgentLoop(initialMessages: readonly IAgentMessage[], config: IAgentRunConfig): AsyncGenerator<IAgentEvent, IAgentTerminal> {
	const signal = config.signal ?? new AbortController().signal;
	const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
	const prepareRequestMessages = config.prepareRequestMessages ?? (messages => messages);
	const specs = config.tools.map(toolSpec);

	// The full transcript. `prepareRequestMessages` (point 5 seam) decides what a
	// request actually sends, keeping "history" and "what the model sees" separate.
	const messages: IAgentMessage[] = [...initialMessages];
	let turn = 0;

	while (true) {
		if (signal.aborted) {
			return { reason: 'aborted', turns: turn };
		}

		turn += 1;
		yield { type: 'turn_start', turn };

		const request: IModelRequest = { system: config.system, messages: prepareRequestMessages(messages), tools: specs, signal };

		// Inner streaming generator: accumulate the assistant message and collect
		// any tool_use blocks as they arrive.
		let assistantText = '';
		const toolUses: IToolUseBlock[] = [];
		let stopReason: ModelStopReason = 'end_turn';

		for await (const event of config.modelClient.stream(request)) {
			if (signal.aborted) {
				return { reason: 'aborted', turns: turn };
			}

			switch (event.type) {
				case 'text_delta':
					assistantText += event.text;
					yield { type: 'assistant_delta', text: event.text };
					break;
				case 'tool_use':
					toolUses.push(event.block);
					break;
				case 'message_stop':
					stopReason = event.stopReason;
					break;
			}
		}

		const assistantBlocks: IContentBlock[] = [];
		if (assistantText.length > 0) {
			assistantBlocks.push({ type: 'text', text: assistantText });
			yield { type: 'assistant_message', text: assistantText };
		}
		assistantBlocks.push(...toolUses);
		messages.push({ role: 'assistant', content: assistantBlocks });

		// Stop condition: no tool_use block == the turn is complete.
		if (toolUses.length === 0) {
			return { reason: stopReason === 'refusal' ? 'refusal' : 'completed', turns: turn };
		}

		// Run the tools, then feed all results back as one user message. Appending
		// tool_results before every tool has finished would interleave them with
		// plain user content and the API would reject the next request.
		const toolResults = yield* executeToolUses(toolUses, config.tools, config.permissionGate, signal);
		messages.push({ role: 'user', content: toolResults });

		if (turn >= maxTurns) {
			return { reason: 'max_turns', turns: turn };
		}
	}
}
