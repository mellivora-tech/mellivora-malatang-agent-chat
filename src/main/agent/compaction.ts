/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentMessage, IModelClient } from './agentTypes.js';

/**
 * Auto-compaction — the lossy top tier of context governance (3.1).
 *
 * When real token usage approaches the model's context window, the HEAD of the
 * in-run transcript is folded into an "anchored summary" and the request view
 * becomes [summary, ...recent tail]. History is never rewritten — same law as
 * tool-output pruning: shape the view, never the history. The summary is
 * incremental: a re-compaction feeds the previous summary back and asks the
 * model to merge in the new facts, so repeated compaction does not degrade
 * layer by layer (opencode's anchored-summary semantics).
 *
 * The threshold needs the model's context window. When it is not configured
 * the whole mechanism stays off — no guessing (opencode: unknown limit
 * disables overflow detection entirely).
 *
 * Kill switch: AGENT_CHAT_COMPACTION=off.
 */

/** Left free for the reply plus one turn of usage-signal lag (usage arrives one request behind). */
export const SAFETY_BUFFER_TOKENS = 16_000;
/** Matches the model client's DEFAULT_MAX_TOKENS; params.maxTokens overrides both. */
export const DEFAULT_OUTPUT_BUDGET_TOKENS = 32_000;
/** Verbatim tail kept out of the summary (~8K tokens — opencode's preserve-recent ceiling). */
export const TAIL_BUDGET_CHARS = 32_000;
/** Incremental circuit breaker: after any attempt, only retry once usage grew this much. */
export const RETRY_GROWTH_TOKENS = 16_000;

/** Per-block cap when serializing history for the summary request (opencode: 2000). */
const SERIALIZE_BLOCK_MAX_CHARS = 2_000;
/** A head smaller than this has nothing worth summarizing. */
const MIN_HEAD_MESSAGES = 2;
/** Rough chars-per-token for the preflight estimate; real usage drives the main trigger. */
const CHARS_PER_TOKEN = 4;

export function isCompactionEnabled(env: NodeJS.ProcessEnv): boolean {
	return env['AGENT_CHAT_COMPACTION'] !== 'off';
}

/** Tokens at which compaction fires; <= 0 means the window is too small to govern. */
export function compactionThreshold(contextWindow: number, outputBudget?: number): number {
	return contextWindow - (outputBudget ?? DEFAULT_OUTPUT_BUDGET_TOKENS) - SAFETY_BUFFER_TOKENS;
}

/** char/4 heuristic — used only for the preflight check before any usage signal exists. */
export function estimateTokens(messages: readonly IAgentMessage[]): number {
	return Math.round(JSON.stringify(messages).length / CHARS_PER_TOKEN);
}

/**
 * Where the verbatim tail starts. Walks from the end within the char budget,
 * then snaps forward to an assistant message so a tool_use and its tool_result
 * can never end up on opposite sides of the cut (an orphan tool_result is an
 * API 400). The last assistant message and everything after it survive even
 * when they exceed the budget. Returns undefined when there is no valid cut or
 * the head is too small to be worth summarizing.
 */
export function selectBoundary(messages: readonly IAgentMessage[], tailBudgetChars: number = TAIL_BUDGET_CHARS): number | undefined {
	let lastAssistant = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]!.role === 'assistant') {
			lastAssistant = i;
			break;
		}
	}
	if (lastAssistant === -1) {
		return undefined;
	}

	let cut = messages.length;
	let total = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		total += JSON.stringify(messages[i]!.content).length;
		if (total > tailBudgetChars) {
			break;
		}
		cut = i;
	}

	while (cut < lastAssistant && messages[cut]!.role !== 'assistant') {
		cut += 1;
	}
	if (cut > lastAssistant) {
		cut = lastAssistant;
	}

	return cut < MIN_HEAD_MESSAGES ? undefined : cut;
}

function clip(text: string): string {
	return text.length <= SERIALIZE_BLOCK_MAX_CHARS ? text : `${text.slice(0, SERIALIZE_BLOCK_MAX_CHARS)}\n[truncated]`;
}

/**
 * Flatten history into labeled plain text for the summary request. Plain text
 * has no tool-pairing or thinking-passback constraints, so the summary call
 * itself can never 400 on structure (opencode v2's serialization approach).
 * Thinking blocks are dropped — they narrate the work the other blocks show.
 * Images become a placeholder line: dropping them silently taught the
 * summarizer to assert "no image was provided" while the image's analysis sat
 * right there in the tail — a false fact anchored into every later summary.
 */
export function serializeForSummary(messages: readonly IAgentMessage[]): string {
	const lines: string[] = [];
	for (const message of messages) {
		for (const block of message.content) {
			if (block.type === 'text') {
				lines.push(`[${message.role === 'user' ? 'User' : 'Assistant'}]:\n${clip(block.text)}`);
			} else if (block.type === 'tool_use') {
				lines.push(`[Assistant tool call ${block.name}]:\n${clip(JSON.stringify(block.input))}`);
			} else if (block.type === 'tool_result') {
				lines.push(`[Tool result${block.isError ? ' (error)' : ''}]:\n${clip(block.content)}`);
			} else if (block.type === 'image') {
				// base64 → ~3/4 raw bytes; enough for the summarizer to know an
				// image existed and was handled in-conversation.
				lines.push(`[User attached an image (${block.mediaType}, ~${Math.max(1, Math.round((block.data.length * 3) / 4 / 1024))}KB) — it was shown to the assistant in this conversation]`);
			}
		}
	}
	return lines.join('\n\n');
}

export const SUMMARY_SYSTEM = 'You maintain a compact anchored summary of an ongoing coding-agent session. Respond with ONLY the summary in the requested Markdown structure — no preamble, no tool calls.';

const SUMMARY_TEMPLATE = `Output exactly the Markdown structure below and keep the section order unchanged.

## Objective
- [what the user is trying to accomplish, one or two terse bullets]

## Key Facts
- [constraints, decisions and why, exact context needed to continue, or "(none)"]

## Work State
### Done
- [finished work and verified facts, or "(none)"]
### Active
- [current work and partial state, or "(none)"]
### Blocked
- [blockers, failing commands, unknowns, or "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]

## Relevant Files
- [path: why it matters, or "(none)"]

Rules:
- Keep every section, even when empty.
- Terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, and identifiers.
- Do not mention the summary process or that context was compacted.`;

/** The user turn sent to the summarizer: history, then (optionally) the anchor to update. */
export function buildSummaryRequestText(serializedHead: string, previousSummary?: string): string {
	const instruction =
		previousSummary === undefined
			? 'Create a new anchored summary from the conversation history above.'
			: `Update the anchored summary below using the conversation history above. Preserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${previousSummary}\n</previous-summary>`;
	return `<conversation-history>\n${serializedHead}\n</conversation-history>\n\n${instruction}\n\n${SUMMARY_TEMPLATE}`;
}

/** The user message that stands in for the summarized head of the request view. */
export function formatCompactedBlock(summary: string): string {
	return `[Context compacted]\nEarlier turns of this conversation were replaced by the anchored summary below. Treat it as accurate prior context and continue from the recent messages that follow.\n\n<summary>\n${summary}\n</summary>`;
}

export interface IGenerateSummaryOptions {
	readonly client: IModelClient;
	readonly serializedHead: string;
	readonly previousSummary?: string;
	readonly signal: AbortSignal;
}

/** One plain model call — no tools, fresh context. Throws on an empty reply. */
export async function generateSummary(options: IGenerateSummaryOptions): Promise<string> {
	let text = '';
	const stream = options.client.stream({
		system: SUMMARY_SYSTEM,
		messages: [{ role: 'user', content: [{ type: 'text', text: buildSummaryRequestText(options.serializedHead, options.previousSummary) }] }],
		tools: [],
		signal: options.signal,
	});
	for await (const event of stream) {
		if (event.type === 'text_delta') {
			text += event.text;
		}
	}
	const summary = text.trim();
	if (summary === '') {
		throw new Error('compaction summary came back empty');
	}
	return summary;
}
