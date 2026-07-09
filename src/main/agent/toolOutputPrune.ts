/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentMessage, IContentBlock, IToolResultBlock } from './agentTypes.js';

/**
 * In-run tool-output aging: old tool_result contents are replaced with a short
 * stub in the REQUEST VIEW only — loop history, persistence, and the UI keep
 * the full text. tool_use blocks (the inputs) are never touched, so "what did
 * I already do" survives; only the re-obtainable outputs age out.
 *
 * The boundary is QUANTIZED for prompt-cache friendliness:
 *
 *     P_target = floor(max(0, T − protect) / quantum) × quantum
 *
 * where T is the total size of prunable outputs. Because history is
 * append-only, prefix sums never change — once a result falls outside the
 * window it stays outside (monotone, stateless), and the pruned set only
 * grows in quantum-sized steps, so consecutive requests keep byte-identical
 * prefixes between steps instead of breaking the provider's prompt cache on
 * every turn. (Claude Code solves this with time-based triggers and a
 * cache-editing API; opencode batches with PRUNE_MINIMUM — quantization is
 * this harness's equivalent.)
 *
 * The newest tool-result message is unconditionally protected: the model just
 * asked for those results and has not read them yet.
 */
const PROTECT_BUDGET_CHARS = 48_000;
const PRUNE_QUANTUM_CHARS = 16_000;

export interface IPruneOptions {
	readonly protectChars?: number;
	readonly quantumChars?: number;
}

export interface IPruneOutcome {
	readonly messages: readonly IAgentMessage[];
	readonly prunedResults: number;
	readonly prunedChars: number;
}

/** Kill switch: AGENT_CHAT_TOOL_PRUNE=off (same pattern as the other guards). */
export function isToolPruneEnabled(env: NodeJS.ProcessEnv): boolean {
	return env['AGENT_CHAT_TOOL_PRUNE'] !== 'off';
}

export function pruneToolOutputs(messages: readonly IAgentMessage[], options: IPruneOptions = {}): IPruneOutcome {
	const protect = options.protectChars ?? PROTECT_BUDGET_CHARS;
	const quantum = options.quantumChars ?? PRUNE_QUANTUM_CHARS;

	// The newest message carrying tool results is off-limits regardless of size.
	let lastToolMessageIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role === 'user' && message.content.some(block => block.type === 'tool_result')) {
			lastToolMessageIndex = i;
			break;
		}
	}

	// Chronological tool results; only those outside the protected message are
	// prunable, but ALL sizes count toward T (a giant fresh result should push
	// older ones out of the window).
	interface ICandidate {
		readonly messageIndex: number;
		readonly blockIndex: number;
		readonly size: number;
		readonly prunable: boolean;
	}
	const candidates: ICandidate[] = [];
	let total = 0;
	messages.forEach((message, messageIndex) => {
		if (message.role !== 'user') {
			return;
		}
		message.content.forEach((block, blockIndex) => {
			if (block.type !== 'tool_result') {
				return;
			}
			const size = block.content.length;
			total += size;
			candidates.push({ messageIndex, blockIndex, size, prunable: messageIndex !== lastToolMessageIndex });
		});
	});

	const target = Math.floor(Math.max(0, total - protect) / quantum) * quantum;
	if (target <= 0) {
		return { messages, prunedResults: 0, prunedChars: 0 };
	}

	// Whole-result granularity: prune oldest-first while the cumulative size
	// stays within the quantized target; a block straddling the boundary stays.
	const pruneSet = new Set<ICandidate>();
	let cumulative = 0;
	let prunedChars = 0;
	for (const candidate of candidates) {
		if (cumulative + candidate.size > target) {
			break;
		}
		cumulative += candidate.size;
		if (candidate.prunable) {
			pruneSet.add(candidate);
			prunedChars += candidate.size;
		}
	}
	if (pruneSet.size === 0) {
		return { messages, prunedResults: 0, prunedChars: 0 };
	}

	// Tool names for the stubs come from the paired tool_use blocks.
	const namesById = new Map<string, string>();
	for (const message of messages) {
		for (const block of message.content) {
			if (block.type === 'tool_use') {
				namesById.set(block.id, block.name);
			}
		}
	}

	const pruneAt = new Map<number, Set<number>>();
	for (const candidate of pruneSet) {
		let set = pruneAt.get(candidate.messageIndex);
		if (!set) {
			set = new Set();
			pruneAt.set(candidate.messageIndex, set);
		}
		set.add(candidate.blockIndex);
	}

	// Untouched messages are returned by reference — cheap, and keeps the
	// request prefix byte-identical between quantum steps.
	const result = messages.map((message, messageIndex) => {
		const blockIndexes = pruneAt.get(messageIndex);
		if (!blockIndexes) {
			return message;
		}
		const content: IContentBlock[] = message.content.map((block, blockIndex) => {
			if (!blockIndexes.has(blockIndex) || block.type !== 'tool_result') {
				return block;
			}
			return stubFor(block, namesById.get(block.toolUseId) ?? 'tool');
		});
		return { role: message.role, content };
	});

	return { messages: result, prunedResults: pruneSet.size, prunedChars };
}

/** Deterministic (no timestamps) so identical prune sets produce identical bytes. */
function stubFor(block: IToolResultBlock, name: string): IToolResultBlock {
	return {
		type: 'tool_result',
		toolUseId: block.toolUseId,
		content: `[pruned] earlier ${name} output (${block.content.length} chars) removed to free context — re-run the tool if needed.`,
		isError: block.isError,
	};
}
