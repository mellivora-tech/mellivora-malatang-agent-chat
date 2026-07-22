/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	IAgentEvent,
	IAgentMessage,
	IAgentRunConfig,
	IAgentTerminal,
	IContentBlock,
	IModelRequest,
	IRedactedThinkingBlock,
	IThinkingBlock,
	IToolUseBlock,
	ModelStopReason,
} from './agentTypes.js';
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
import { isReplyVerifierEnabled } from './replyVerifier.js';
import { HookRegistry, runHooksUntilBlock, type IHook } from './hooks/hooks.js';
import {
	EXPLORE_TOOLS,
	createActionClaimNudgeHook,
	createFanOutNudgeHook,
	createGroundingNudgeHook,
	createLiveSystemNudgeHook,
	createReplyVerifierHook,
	createStaleClaimNudgeHook,
	createWalkthroughNudgeHook,
	isFanOutNudgeEnabled,
	isLiveSystemNudgeEnabled,
	type IReplyVerifierData,
} from './hooks/builtinHooks.js';
import { isToolPruneEnabled, pruneToolOutputs } from './toolOutputPrune.js';
import { buildWorkDigestEvent, createWorkDigest, isWorkDigestEnabled, recordWorkDigest, seedWorkDigestFromMessages, seedWorkDigestFromText } from './workDigest.js';
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

/**
 * Injected once when a run finishes a reply that quotes code while having made
 * ZERO tool calls, in a session whose digest names previously-explored files.
 * That combination means the model is reconstructing code from digest memory —
 * the run boundary dropped the actual file contents — which produced confident
 * but wrong "current code" quotes in real logs (2026-07-14). CC's counterpart
 * is the loop-exit verification nudge ("you cannot self-assign PARTIAL").
 */
/** The tools whose absence makes a connection claim ungrounded. */
const DATA_SOURCE_TOOLS: ReadonlySet<string> = new Set(['query_data_source', 'list_data_sources']);

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

/** A 429 — retryable, but when the whole backoff ladder fails it means a rate WINDOW is exhausted (usually the 5h window): a pausable run freezes instead of dying (#19 缺陷 2). */
function isRateLimitStreamError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /failed: 429/.test(message);
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
	const verifierEnabled = !config.disableReplyVerifier && isReplyVerifierEnabled(process.env);
	// Walkthrough nudge: if a run actually changed files but never wrote a
	// walkthrough, force ONE hidden turn asking for it (the prompt's soft
	// request is unreliable — models often just stop). Only when the tool is in
	// play (present iff the session has code roots + the P3 build).
	const walkthroughToolAvailable = config.tools.some(tool => tool.name === 'write_walkthrough');
	let filesChangedThisRun = false;
	let walkthroughWritten = false;
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
	// Grounding nudge state: fires only when the seeded digest proves earlier
	// runs explored files (so there IS dropped content to misremember), and at
	// most once per run.
	const seededDigestHasFiles = workDigest.filesRead.size + workDigest.filesEdited.size + workDigest.filesWritten.size > 0;
	let anyToolCallThisRun = false;
	// Stale-claim nudge state: only meaningful when the session actually has
	// data-source tools to test a connection claim with; at most once per run.
	const dataSourceToolsAvailable = config.tools.some(tool => DATA_SOURCE_TOOLS.has(tool.name));
	let dataSourceToolCalledThisRun = false;
	// Stop-event hooks (design docs/design/hooks §7): the completed-branch
	// interceptions — grounding / stale-claim / action-claim / reply-verifier /
	// walkthrough — as registered Stop hooks, dispatched first-block-wins in this
	// order. `firedStopHooks` is the once-per-run guard; each hook reads its
	// run-state live through getters. Gated on the same static availability the
	// old inline conditions used.
	const firedStopHooks = new Set<string>();
	const stopHooks = new HookRegistry();
	if (seededDigestHasFiles) {
		stopHooks.register(createGroundingNudgeHook({ seededDigestHasFiles, anyToolCall: () => anyToolCallThisRun }));
	}
	if (dataSourceToolsAvailable) {
		stopHooks.register(createStaleClaimNudgeHook({ dataSourceToolsAvailable, dataSourceToolCalled: () => dataSourceToolCalledThisRun }));
	}
	if (config.tools.length > 0) {
		stopHooks.register(createActionClaimNudgeHook({ toolsAvailable: config.tools.length > 0, anyToolCall: () => anyToolCallThisRun }));
	}
	if (verifierEnabled) {
		stopHooks.register(createReplyVerifierHook({ client: config.modelClient, signal: () => signal }));
	}
	if (walkthroughToolAvailable) {
		stopHooks.register(createWalkthroughNudgeHook({ walkthroughToolAvailable, filesChanged: () => filesChangedThisRun, walkthroughWritten: () => walkthroughWritten }));
	}
	// PreToolUse hooks (design §10 M2): discipline checks fired before each tool
	// runs, per run.
	//  · W4 — inject the live-system quiescence reminder onto the first data-source
	//    query so a diff of a moving target gets caught.
	//  · W2 — after a streak of single-exploration-tool turns, nudge toward parallel
	//    spawn_agent fan-out. `singleExploreStreak` is maintained below per turn.
	let singleExploreStreak = 0;
	const spawnAgentAvailable = config.tools.some(tool => tool.name === 'spawn_agent');
	const preToolHooks: IHook[] = [];
	if (dataSourceToolsAvailable && isLiveSystemNudgeEnabled(process.env)) {
		preToolHooks.push(createLiveSystemNudgeHook());
	}
	if (spawnAgentAvailable && isFanOutNudgeEnabled(process.env)) {
		preToolHooks.push(createFanOutNudgeHook({ streak: () => singleExploreStreak, spawnAvailable: true }));
	}
	// User hooks register AFTER the built-ins (§4: built-ins are the safety floor).
	// Only Stop and PreToolUse have live dispatch points today; hooks for other
	// events are inert until those fire points land.
	for (const hook of config.userHooks ?? []) {
		if (hook.event === 'Stop') {
			stopHooks.register(hook);
		} else if (hook.event === 'PreToolUse') {
			preToolHooks.push(hook);
		}
	}
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

	// Every abort checkpoint routes through here: an abort caused by the quota
	// fast-stop (the wrapper flags it, see pauseOnExhaustion.quotaHit) settles
	// as a resumable PAUSE carrying the frozen transcript; a plain abort is the
	// user's stop. `messages` at any checkpoint ends on a completed message
	// (assistant turn or tool_results) — partial streams never enter it, so the
	// frozen transcript is always a valid resume point.
	const settleAbort = (): IAgentTerminal => {
		const quotaMessage = config.pauseOnExhaustion?.quotaHit();
		return quotaMessage !== undefined
			? { reason: 'paused', turns: turn, paused: { cause: 'quota', message: quotaMessage, frozenTranscript: [...messages] } }
			: { reason: 'aborted', turns: turn };
	};

	while (true) {
		if (signal.aborted) {
			return settleAbort();
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
							return settleAbort();
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
		let thinkingBlocks: (IThinkingBlock | IRedactedThinkingBlock)[];
		let stopReason: ModelStopReason;

		for (let attempt = 1; ; attempt++) {
			assistantText = '';
			toolUses = [];
			thinkingBlocks = [];
			stopReason = 'end_turn';
			try {
				for await (const event of config.modelClient.stream(request)) {
					if (signal.aborted) {
						return settleAbort();
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
							if (event.block.type === 'redacted_thinking') {
								yield { type: 'thinking_redacted' };
							}
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
					return settleAbort();
				}
				const exhausted = assistantText.length > 0 || attempt >= MAX_STREAM_ATTEMPTS;
				// 429 exhaustion on a pausable run: the whole backoff ladder failed,
				// so a rate WINDOW (usually the 5h one) is empty — freeze resumable
				// instead of dying (#19 缺陷 2). Note the trigger lives HERE, not in
				// the fast-stop wrapper: a first-sight 429 usually heals on retry
				// and aborting it early would kill healthy runs. The partial turn
				// (if any streamed) is NOT in `messages` — resume regenerates it.
				if (config.pauseOnExhaustion && exhausted && isRateLimitStreamError(error)) {
					return {
						reason: 'paused',
						turns: turn,
						paused: { cause: 'rate_limit', message: error instanceof Error ? error.message : String(error), frozenTranscript: [...messages] },
					};
				}
				if (exhausted || !isRetryableStreamError(error)) {
					throw error;
				}
				const delayMs = Math.min(MAX_RETRY_DELAY_MS, (config.streamRetryBaseDelayMs ?? BASE_RETRY_DELAY_MS) * 2 ** (attempt - 1));
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
		if (toolUses.length > 0) {
			anyToolCallThisRun = true;
		}
		if (toolUses.some(toolUse => DATA_SOURCE_TOOLS.has(toolUse.name))) {
			dataSourceToolCalledThisRun = true;
		}
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

			// Stop-event hooks (design docs/design/hooks §7): the five completed-branch
			// interceptions, dispatched FIRST-BLOCK-WINS in registration order (grounding,
			// stale-claim, action-claim, reply-verifier, walkthrough). At most one fires
			// per completed turn, then a retry; each fired/ran hook emits its own event,
			// and `firedStopHooks` enforces once-per-run.
			if (reason === 'completed') {
				const eligible = stopHooks.forEvent('Stop').filter(hook => !firedStopHooks.has(hook.id));
				if (eligible.length > 0) {
					const outcome = await runHooksUntilBlock(eligible, { event: 'Stop', ...(question !== undefined ? { question } : {}), answer: assistantText });
					if (signal.aborted) {
						return settleAbort();
					}
					for (const result of outcome.results) {
						switch (result.hookId) {
							case 'builtin:grounding-nudge':
								if (result.decision === 'block') {
									firedStopHooks.add(result.hookId);
									yield { type: 'grounding_nudge' };
								}
								break;
							case 'builtin:stale-claim-nudge':
								if (result.decision === 'block') {
									firedStopHooks.add(result.hookId);
									yield { type: 'stale_claim_nudge' };
								}
								break;
							case 'builtin:action-claim-nudge':
								if (result.decision === 'block') {
									firedStopHooks.add(result.hookId);
									yield { type: 'action_claim_nudge' };
								}
								break;
							case 'builtin:walkthrough-nudge':
								if (result.decision === 'block') {
									firedStopHooks.add(result.hookId);
								}
								break;
							case 'builtin:reply-verifier': {
								if (result.data !== undefined) {
									firedStopHooks.add(result.hookId);
									const { verdict, reason: judgeReason } = result.data as IReplyVerifierData;
									yield { type: 'reply_verifier', verdict, retried: verdict === 'fail', ...(judgeReason ? { reason: judgeReason } : {}) };
								}
								break;
							}
							default:
								// A user hook: guard on block so it fires at most once per run (a
								// re-blocking hook must not spin the loop). Its reason rides the
								// pushed retry message below; the hook event records it in the log.
								if (result.decision === 'block') {
									firedStopHooks.add(result.hookId);
									yield { type: 'hook', event: 'Stop', hookId: result.hookId, decision: 'block' };
								} else if (result.failOpen !== undefined) {
									// It allowed, but only because it broke (bad command, timeout,
									// crash). Recorded precisely BECAUSE it had no effect — otherwise
									// a hook that silently stopped working looks like one that ran.
									yield { type: 'hook', event: 'Stop', hookId: result.hookId, decision: result.decision, failOpen: true };
								}
								break;
						}
					}
					if (outcome.decision === 'block' && outcome.reason !== undefined) {
						messages.push({ role: 'user', content: [{ type: 'text', text: outcome.reason }] });
						continue;
					}
				}
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
		const toolResults = yield* executeToolUses(toolUses, config.tools, config.permissionGate, signal, loopGuard, preToolHooks);

		// W2 streak: a turn that made exactly ONE exploration tool call extends the
		// serial-probe streak; anything else (a batch, a non-explore tool) breaks it.
		singleExploreStreak = toolUses.length === 1 && EXPLORE_TOOLS.has(toolUses[0]!.name) ? singleExploreStreak + 1 : 0;
		messages.push({ role: 'user', content: toolResults });

		// A sub-agent's result carries its own <work-digest> block: fold those
		// files into THIS run's digest so the next run knows the child covered
		// them — otherwise delegation re-opens the re-exploration tax it closed.
		if (digestEnabled) {
			for (const block of toolResults) {
				if (block.type === 'tool_result' && block.content.includes('<work-digest>')) {
					seedWorkDigestFromText(workDigest, block.content);
					digestWorkedThisRun = true;
				}
			}
		}

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
