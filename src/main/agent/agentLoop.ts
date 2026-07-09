/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentEvent, IAgentMessage, IAgentRunConfig, IAgentTerminal, IContentBlock, IModelRequest, IToolUseBlock, ModelStopReason } from './agentTypes.js';
import { toolSpec } from './agentTools.js';
import { createLoopGuard } from './loopGuard.js';
import { buildRetryFeedback, isReplyVerifierEnabled, verifyReply } from './replyVerifier.js';
import { isToolPruneEnabled, pruneToolOutputs } from './toolOutputPrune.js';
import { executeToolUses } from './toolRunner.js';

const DEFAULT_MAX_TURNS = 100;
// Deterministic convergence brake — enforced by the harness, not the model.
// Soft: nudge the model to wrap up. Hard: withhold tools so it MUST answer.
const SOFT_BRAKE_RATIO = 0.7;
const HARD_BRAKE_RATIO = 0.9;
const SOFT_BRAKE_REMINDER =
	'<system-reminder>You have used most of your step budget. Wrap up: finish the current thread and give your final answer soon. Do not open new lines of investigation.</system-reminder>';
const HARD_BRAKE_REMINDER =
	'<system-reminder>Step budget reached. Tools are no longer available this turn — give your final answer now from what you already know, and state plainly anything you could not verify (e.g. it depends on runtime data).</system-reminder>';

/** Append a reminder to the model's view of the transcript without touching history. */
function withReminder(messages: readonly IAgentMessage[], reminder: string): IAgentMessage[] {
	const block: IContentBlock = { type: 'text', text: reminder };
	const last = messages[messages.length - 1];
	if (last && last.role === 'user') {
		return [...messages.slice(0, -1), { role: 'user', content: [...last.content, block] }];
	}
	return [...messages, { role: 'user', content: [block] }];
}

/** The question the reply verifier judges against: the latest user text in the transcript. */
function extractLatestUserText(messages: readonly IAgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== 'user') {
			continue;
		}
		const text = message.content
			.filter((block): block is IContentBlock & { type: 'text' } => block.type === 'text')
			.map(block => block.text)
			.join('\n')
			.trim();
		if (text !== '') {
			return text;
		}
	}
	return undefined;
}

const MAX_STREAM_ATTEMPTS = 10;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 10_000;

/** Connection hiccups and transient server errors heal on retry; auth/validation do not. */
function isRetryableStreamError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	if (/failed: (408|409|429|5\d\d)/.test(message)) {
		return true;
	}
	return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|network|terminated/i.test(message);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		const timer = setTimeout(done, ms);
		function done(): void {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		}
		signal.addEventListener('abort', done, { once: true });
	});
}

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
	const softBrakeTurn = Math.max(1, Math.floor(maxTurns * SOFT_BRAKE_RATIO));
	const hardBrakeTurn = Math.max(1, Math.floor(maxTurns * HARD_BRAKE_RATIO));
	// Fresh per run: a user's explicit "try again" starts a new run, so the
	// repeated-call counter never fights a deliberate retry.
	const loopGuard = createLoopGuard(process.env);
	// Reply verifier state: the question is the latest user text in the initial
	// transcript; at most one verification (and one retry) per run.
	const question = extractLatestUserText(initialMessages);
	const verifierEnabled = isReplyVerifierEnabled(process.env);
	let verifierFired = false;
	// Tool-output aging: emit telemetry only when the pruned set grows.
	const pruneEnabled = isToolPruneEnabled(process.env);
	let lastPrunedResults = 0;
	let turn = 0;

	while (true) {
		if (signal.aborted) {
			return { reason: 'aborted', turns: turn };
		}

		turn += 1;
		yield { type: 'turn_start', turn };

		// Convergence brake: past the soft line, nudge; past the hard line, withhold
		// tools so the model can only produce a final answer (deterministic — it does
		// not rely on the model choosing to stop).
		const brake = specs.length > 0 && turn >= hardBrakeTurn ? 'hard' : specs.length > 0 && turn >= softBrakeTurn ? 'soft' : 'none';

		// Tool-output aging shapes the request view only (history keeps full text);
		// the reminder is appended after so it can never be pruned.
		let prepared = prepareRequestMessages(messages);
		if (pruneEnabled) {
			const pruned = pruneToolOutputs(prepared);
			prepared = pruned.messages;
			if (pruned.prunedResults > lastPrunedResults) {
				lastPrunedResults = pruned.prunedResults;
				yield { type: 'tool_prune', prunedResults: pruned.prunedResults, prunedChars: pruned.prunedChars };
			}
		}
		const requestMessages = brake === 'hard' ? withReminder(prepared, HARD_BRAKE_REMINDER) : brake === 'soft' ? withReminder(prepared, SOFT_BRAKE_REMINDER) : prepared;
		const request: IModelRequest = { system: config.system, messages: requestMessages, tools: brake === 'hard' ? [] : specs, signal };

		// Inner streaming generator: accumulate the assistant message and collect
		// any tool_use blocks as they arrive. A stream that fails before any text
		// reached the consumer is retried with backoff (a retry after visible text
		// would duplicate output, so those errors surface instead).
		let assistantText: string;
		let toolUses: IToolUseBlock[];
		let stopReason: ModelStopReason;

		for (let attempt = 1; ; attempt++) {
			assistantText = '';
			toolUses = [];
			stopReason = 'end_turn';
			try {
				for await (const event of config.modelClient.stream(request)) {
					if (signal.aborted) {
						return { reason: 'aborted', turns: turn };
					}

					switch (event.type) {
						case 'text_delta':
							assistantText += event.text;
							yield { type: 'assistant_delta', text: event.text };
							break;
						case 'thinking_delta':
							yield { type: 'thinking_delta', text: event.text };
							break;
						case 'tool_use':
							toolUses.push(event.block);
							break;
						case 'usage':
							yield { type: 'usage', inputTokens: event.inputTokens, ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}) };
							break;
						case 'message_stop':
							stopReason = event.stopReason;
							break;
					}
				}
				break;
			} catch (error) {
				if (signal.aborted) {
					return { reason: 'aborted', turns: turn };
				}
				if (assistantText.length > 0 || attempt >= MAX_STREAM_ATTEMPTS || !isRetryableStreamError(error)) {
					throw error;
				}
				const delayMs = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));
				yield { type: 'stream_retry', attempt, maxAttempts: MAX_STREAM_ATTEMPTS, delayMs };
				await delay(delayMs, signal);
			}
		}

		const assistantBlocks: IContentBlock[] = [];
		if (assistantText.length > 0) {
			assistantBlocks.push({ type: 'text', text: assistantText });
			yield { type: 'assistant_message', text: assistantText };
		}
		assistantBlocks.push(...toolUses);
		messages.push({ role: 'assistant', content: assistantBlocks });

		// Stop condition: no tool_use block == the turn is complete. A max_tokens
		// stop is surfaced as its own reason — the reply was truncated (possibly
		// to nothing, if thinking consumed the whole budget), and folding it into
		// 'completed' would hide that from logs and the UI.
		if (toolUses.length === 0) {
			const reason = stopReason === 'refusal' ? 'refusal' : stopReason === 'max_tokens' ? 'max_output_tokens' : 'completed';

			// Reply verifier: at the moment of a genuine submission, one cheap judge
			// call checks the reply addresses the question. A 'fail' feeds the
			// rejection back (hidden user message, CC Stop-hook style) and grants
			// exactly one retry; 'error' is fail-open. Other stop reasons have
			// their own handling and are never verified.
			if (reason === 'completed' && verifierEnabled && !verifierFired && question !== undefined && assistantText.trim() !== '') {
				verifierFired = true;
				const verification = await verifyReply({ client: config.modelClient, question, answer: assistantText, signal });
				if (signal.aborted) {
					return { reason: 'aborted', turns: turn };
				}
				const retried = verification.verdict === 'fail';
				yield { type: 'reply_verifier', verdict: verification.verdict, retried, ...(verification.reason ? { reason: verification.reason } : {}) };
				if (retried) {
					messages.push({ role: 'user', content: [{ type: 'text', text: buildRetryFeedback(question, verification.reason) }] });
					continue;
				}
			}

			return { reason, turns: turn };
		}

		// Run the tools, then feed all results back as one user message. Appending
		// tool_results before every tool has finished would interleave them with
		// plain user content and the API would reject the next request.
		const toolResults = yield* executeToolUses(toolUses, config.tools, config.permissionGate, signal, loopGuard);
		messages.push({ role: 'user', content: toolResults });

		if (turn >= maxTurns) {
			return { reason: 'max_turns', turns: turn };
		}
	}
}
