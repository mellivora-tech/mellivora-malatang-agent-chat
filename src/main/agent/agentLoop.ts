/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentEvent, IAgentMessage, IAgentRunConfig, IAgentTerminal, IContentBlock, IModelRequest, IThinkingBlock, IToolUseBlock, ModelStopReason } from './agentTypes.js';
import { toolSpec } from './agentTools.js';
import {
	RETRY_GROWTH_TOKENS,
	compactionThreshold,
	estimateTokens,
	formatCompactedBlock,
	generateSummary,
	isCompactionEnabled,
	selectBoundary,
	serializeForSummary,
} from './compaction.js';
import { createLoopGuard } from './loopGuard.js';
import { buildRetryFeedback, isReplyVerifierEnabled, verifyReply } from './replyVerifier.js';
import { isToolPruneEnabled, pruneToolOutputs } from './toolOutputPrune.js';
import { buildWorkDigestEvent, createWorkDigest, isWorkDigestEnabled, recordWorkDigest, seedWorkDigestFromMessages } from './workDigest.js';
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

/** Injected once when a file-changing run ends without a walkthrough — forces one. */
const WALKTHROUGH_NUDGE =
	'<system-reminder>You changed files in this task but have not recorded a walkthrough. Call write_walkthrough now with a short sectioned report — what changed (files) and how to verify it (verify) — then close with one short sentence. Do not repeat the edits; just summarize.</system-reminder>';

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
	// Walkthrough nudge: if a run actually changed files but never wrote a
	// walkthrough, force ONE hidden turn asking for it (the prompt's soft
	// request is unreliable — models often just stop). Only when the tool is in
	// play (present iff the session has code roots + the P3 build).
	const walkthroughToolAvailable = config.tools.some(tool => tool.name === 'write_walkthrough');
	let filesChangedThisRun = false;
	let walkthroughWritten = false;
	let walkthroughNudged = false;
	// Work digest: deterministically accumulate what this run touched (files
	// read/changed + activity counts) and sink it at run end, so the next run's
	// transcript opens knowing what was already explored (see workDigest.ts).
	const digestEnabled = isWorkDigestEnabled(process.env);
	const workDigest = createWorkDigest();
	// Seed from the previous run's digest (it rides the transcript as an
	// assistant turn) so the file union is cumulative across the whole session.
	if (digestEnabled) {
		seedWorkDigestFromMessages(workDigest, initialMessages);
	}
	// Did THIS run touch a tracked tool? A conversational run leaves the seeded
	// (previous) digest to ride forward untouched instead of re-emitting it.
	let digestWorkedThisRun = false;
	// Tool-output aging: emit telemetry only when the pruned set grows.
	const pruneEnabled = isToolPruneEnabled(process.env);
	let lastPrunedResults = 0;
	// Auto-compaction: enabled only when the model's context window is known.
	// The trigger reads real usage (one request behind — the safety buffer in the
	// threshold absorbs that lag); turn 1 uses a rough estimate as preflight.
	const compactThreshold = config.compaction ? compactionThreshold(config.compaction.contextWindow, config.compaction.outputBudget) : 0;
	const compactionOn = compactThreshold > 0 && isCompactionEnabled(process.env);
	// A persisted anchor (validated by the caller via restoreAnchor) pre-seeds
	// the view: the same head costs one summary call per SESSION, not per run.
	let compacted: { boundary: number; summary: string } | undefined =
		compactionOn && config.compaction?.anchor ? { boundary: config.compaction.anchor.covered, summary: config.compaction.anchor.summary } : undefined;
	let lastUsageTokens = 0;
	let lastCompactionAttemptTokens = 0;
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

		// Compaction check — before the view is assembled. Fires on real usage from
		// the previous turn (turn 1: rough preflight estimate); the incremental
		// breaker retries only after usage grew another quantum, so a failed or
		// insufficient attempt cannot re-fire every turn.
		if (compactionOn) {
			const trigger = turn === 1 ? 'preflight' : 'auto';
			const beforeTokens = turn === 1 ? estimateTokens(messages) : lastUsageTokens;
			const due = beforeTokens >= compactThreshold && (lastCompactionAttemptTokens === 0 || beforeTokens >= lastCompactionAttemptTokens + RETRY_GROWTH_TOKENS);
			if (due) {
				lastCompactionAttemptTokens = beforeTokens;
				const boundary = selectBoundary(messages);
				if (boundary === undefined || (compacted !== undefined && boundary <= compacted.boundary)) {
					// Nothing (new) to fold — the honest signal, not a silent loop.
					yield { type: 'compaction', trigger, beforeTokens, boundaryIndex: boundary ?? -1, summaryChars: compacted?.summary.length ?? 0, outcome: 'insufficient' };
				} else {
					try {
						// Incremental anchor: summarize only the delta since the last
						// boundary and fold it into the previous summary.
						const summary = await generateSummary({
							client: config.modelClient,
							serializedHead: serializeForSummary(messages.slice(compacted?.boundary ?? 0, boundary)),
							...(compacted !== undefined ? { previousSummary: compacted.summary } : {}),
							signal,
						});
						compacted = { boundary, summary };
						// coveredInitial maps the boundary into the renderer's coordinate
						// system (in-run indices don't survive the run).
						yield {
							type: 'compaction',
							trigger,
							beforeTokens,
							boundaryIndex: boundary,
							summaryChars: summary.length,
							outcome: 'ok',
							summary,
							coveredInitial: Math.min(boundary, initialMessages.length),
						};
					} catch {
						if (signal.aborted) {
							return { reason: 'aborted', turns: turn };
						}
						// Fail-open: keep sending uncompacted — a few more turns usually
						// still fit, and the provider's own error stays the backstop.
						yield { type: 'compaction', trigger, beforeTokens, boundaryIndex: boundary, summaryChars: 0, outcome: 'error' };
					}
				}
			}
		}

		// The request view: compaction first (summary replaces the head), then the
		// point-5 seam, then tool-output aging shapes what remains (history keeps
		// full text); the reminder is appended last so it can never be pruned.
		const view: readonly IAgentMessage[] = compacted
			? [{ role: 'user', content: [{ type: 'text', text: formatCompactedBlock(compacted.summary) }] }, ...messages.slice(compacted.boundary)]
			: messages;
		let prepared = prepareRequestMessages(view);
		let prunedCharsThisTurn = 0;
		if (pruneEnabled) {
			const pruned = pruneToolOutputs(prepared);
			prepared = pruned.messages;
			prunedCharsThisTurn = pruned.prunedChars;
			if (pruned.prunedResults > lastPrunedResults) {
				lastPrunedResults = pruned.prunedResults;
				yield { type: 'tool_prune', prunedResults: pruned.prunedResults, prunedChars: pruned.prunedChars };
			}
		}
		const requestMessages = brake === 'hard' ? withReminder(prepared, HARD_BRAKE_REMINDER) : brake === 'soft' ? withReminder(prepared, SOFT_BRAKE_REMINDER) : prepared;
		const requestTools = brake === 'hard' ? [] : specs;
		const request: IModelRequest = { system: config.system, messages: requestMessages, tools: requestTools, signal };

		// Context panel data — what this turn's view is made of. The compacted
		// summary always lands at requestMessages[0] (compaction places it first
		// in `view`, and neither prune — which only rewrites tool_result content
		// in place — nor the reminder — appended to/after the LAST message —
		// ever touch index 0), so its size is split out from the rest cleanly.
		const compactedChars = compacted ? JSON.stringify(requestMessages[0]!.content).length : 0;
		const messagesChars = requestMessages.reduce((sum, message, index) => (index === 0 && compacted ? sum : sum + JSON.stringify(message.content).length), 0);
		yield {
			type: 'context_breakdown',
			turn,
			systemChars: config.systemBreakdown?.baseChars ?? config.system.length,
			instructionsChars: config.systemBreakdown?.instructionsChars ?? 0,
			skillsChars: config.systemBreakdown?.skillsChars ?? 0,
			toolsChars: JSON.stringify(requestTools).length,
			messagesChars,
			compactedChars,
			prunedChars: prunedCharsThisTurn,
		};

		// Inner streaming generator: accumulate the assistant message and collect
		// any tool_use blocks as they arrive. A stream that fails before any text
		// reached the consumer is retried with backoff (a retry after visible text
		// would duplicate output, so those errors surface instead).
		let assistantText: string;
		let toolUses: IToolUseBlock[];
		let thinkingBlocks: IThinkingBlock[];
		let stopReason: ModelStopReason;

		for (let attempt = 1; ; attempt++) {
			assistantText = '';
			toolUses = [];
			thinkingBlocks = [];
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
						case 'thinking_block':
							thinkingBlocks.push(event.block);
							break;
						case 'tool_use':
							toolUses.push(event.block);
							break;
						case 'usage':
							// The true prompt size is input + BOTH cache fields (Anthropic
							// wire semantics: input_tokens excludes cache hits — counting it
							// alone under-reads occupancy by the whole cached prefix), plus
							// output because the next request carries this turn's output too.
							lastUsageTokens = event.inputTokens + (event.cacheReadTokens ?? 0) + (event.cacheWriteTokens ?? 0) + (event.outputTokens ?? 0);
							yield {
								type: 'usage',
								inputTokens: event.inputTokens,
								...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
								...(event.cacheReadTokens !== undefined ? { cacheReadTokens: event.cacheReadTokens } : {}),
								...(event.cacheWriteTokens !== undefined ? { cacheWriteTokens: event.cacheWriteTokens } : {}),
							};
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

		// Canonical Anthropic layout: thinking first, then text, then tool_use.
		// Preserving the thinking blocks (with signatures) is required by the API
		// whenever extended thinking is enabled with tool use.
		const assistantBlocks: IContentBlock[] = [...thinkingBlocks];
		if (assistantText.length > 0) {
			assistantBlocks.push({ type: 'text', text: assistantText });
			yield { type: 'assistant_message', text: assistantText };
		}
		assistantBlocks.push(...toolUses);
		messages.push({ role: 'assistant', content: assistantBlocks });

		// Track file-changing activity and whether the walkthrough was written,
		// across all turns of this run (drives the nudge at convergence).
		for (const toolUse of toolUses) {
			if (toolUse.name === 'write_file' || toolUse.name === 'edit_file') {
				filesChangedThisRun = true;
			} else if (toolUse.name === 'write_walkthrough') {
				walkthroughWritten = true;
			}
			if (digestEnabled && recordWorkDigest(workDigest, toolUse.name, toolUse.input)) {
				digestWorkedThisRun = true;
			}
		}

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

			// Walkthrough nudge: a run that changed files but never wrote a
			// walkthrough gets exactly one forced turn to produce one. Deterministic
			// (based on the tools actually called), so it never relies on the model
			// remembering the prompt's soft request.
			if (reason === 'completed' && walkthroughToolAvailable && filesChangedThisRun && !walkthroughWritten && !walkthroughNudged) {
				walkthroughNudged = true;
				messages.push({ role: 'user', content: [{ type: 'text', text: WALKTHROUGH_NUDGE }] });
				continue;
			}

			if (digestEnabled && digestWorkedThisRun) {
				const digest = buildWorkDigestEvent(workDigest);
				if (digest) {
					yield { type: 'work_digest', ...digest };
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
			if (digestEnabled && digestWorkedThisRun) {
				const digest = buildWorkDigestEvent(workDigest);
				if (digest) {
					yield { type: 'work_digest', ...digest };
				}
			}
			return { reason: 'max_turns', turns: turn };
		}
	}
}
