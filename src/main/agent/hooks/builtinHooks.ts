/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IModelClient } from '../agentTypes.js';
import { buildRetryFeedback, verifyReply, type ReplyVerdict } from '../replyVerifier.js';
import type { IHook, IHookDecision, IHookInput } from './hooks.js';

/** Structured payload the reply-verifier hook rides on `decision.data`, so the loop can emit its `reply_verifier` event faithfully. */
export interface IReplyVerifierData {
	readonly verdict: ReplyVerdict;
	readonly reason: string;
}

/**
 * Built-in hooks: agentLoop's hardcoded Stop-branch interceptions, re-expressed
 * as registered Stop hooks (design §7 migration) — the reply verifier plus the
 * four nudges (grounding / stale-claim / action-claim / walkthrough). Behavior
 * is preserved exactly: each blocks with the same feedback under the same
 * condition, and the loop dispatches them first-block-wins in the original
 * order. The reply verifier's verdict rides `decision.data` so the loop still
 * emits its `reply_verifier` event verbatim.
 */

export interface IReplyVerifierHookDeps {
	readonly client: IModelClient;
	/** Fetched per run — the verifier call is cancellable with the run's signal. */
	readonly signal: () => AbortSignal;
}

export function createReplyVerifierHook(deps: IReplyVerifierHookDeps): IHook {
	return {
		id: 'builtin:reply-verifier',
		event: 'Stop',
		async run(input: IHookInput): Promise<IHookDecision> {
			// Nothing to verify without a question and a non-empty reply — allow.
			if (input.question === undefined || input.answer === undefined || input.answer.trim() === '') {
				return { decision: 'allow' };
			}
			const verification = await verifyReply({ client: deps.client, question: input.question, answer: input.answer, signal: deps.signal() });
			const data: IReplyVerifierData = { verdict: verification.verdict, reason: verification.reason };
			if (verification.verdict === 'fail') {
				return { decision: 'block', reason: buildRetryFeedback(input.question, verification.reason), data };
			}
			// pass, or error (fail-open — a broken judge never harms a normal reply).
			return { decision: 'allow', data };
		},
	};
}

// --- ungrounded-claim + walkthrough nudges (design §7) ---------------------------
// Each nudge is a Stop hook that BLOCKS with a system-reminder when its condition
// holds, else allows. The loop dispatches them first-block-wins and holds the
// once-per-run guard (a hook fires at most once); their run-state (tool-call
// flags) is read live through getter deps.

export const GROUNDING_NUDGE =
	'<system-reminder>Your reply quotes or describes code, but you made no tool calls in this run. The work digest carries only file NAMES from earlier runs — the file contents are no longer in your context, so code quoted from memory may be wrong. Re-read the relevant files now (read-only tools never need approval), verify every code-level claim against the actual source, then give your corrected answer. Ask the user only for runtime data the code cannot show.</system-reminder>';

export const STALE_CLAIM_NUDGE =
	'<system-reminder>Your reply claims a connection or availability failure, but you did not call any data-source tool in this run. An earlier failure may have been fixed since — configurations change between runs. Test it NOW: call query_data_source (or list_data_sources), report what actually happens, and quote only errors produced in this run. If the connection works, answer the user with real data instead.</system-reminder>';

/** Connection-failure assertions that must be grounded by a this-run tool call (zh + en + raw error codes). */
export const CONNECTION_CLAIM =
	/连不上|连接不上|无法连接|连接失败|连接超时|数据库.{0,8}不可用|cannot connect|can't connect|connection (?:failed|refused|timed out)|unreachable|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|UnknownHostException/i;

export const ACTION_CLAIM_NUDGE =
	'<system-reminder>Your reply claims actions were performed (deploy / upload / restart / build …), but you made ZERO tool calls in this run — nothing was actually executed. Either perform the work NOW with your tools, or state plainly that it has NOT been done yet and what you would do. Never present remembered or planned work as completed.</system-reminder>';

/** Completed-action assertions that must be grounded by a this-run tool call (zh + en). */
export const ACTION_CLAIM =
	/已部署|部署完成|部署成功|部署结果|已上传|上传完成|上传成功|已重启|重启完成|重启成功|已执行|执行成功|编译成功|构建成功|已提交|提交成功|deployed successfully|upload(?:ed)? (?:complete|successful)|restarted successfully|build succeeded/i;

export const WALKTHROUGH_NUDGE =
	'<system-reminder>You changed files in this task but have not recorded a walkthrough. Call write_walkthrough now with a short sectioned report — what changed (files) and how to verify it (verify) — then close with one short sentence. Do not repeat the edits; just summarize.</system-reminder>';

/** Quoting code (```-fenced) with zero tool calls in a digest-seeded run → re-ground. */
export function createGroundingNudgeHook(deps: { readonly seededDigestHasFiles: boolean; readonly anyToolCall: () => boolean }): IHook {
	return {
		id: 'builtin:grounding-nudge',
		event: 'Stop',
		run: input =>
			deps.seededDigestHasFiles && !deps.anyToolCall() && (input.answer ?? '').includes('```') ? { decision: 'block', reason: GROUNDING_NUDGE } : { decision: 'allow' },
	};
}

/** Asserting a connection failure without a this-run data-source call → force a real test. */
export function createStaleClaimNudgeHook(deps: { readonly dataSourceToolsAvailable: boolean; readonly dataSourceToolCalled: () => boolean }): IHook {
	return {
		id: 'builtin:stale-claim-nudge',
		event: 'Stop',
		run: input =>
			deps.dataSourceToolsAvailable && !deps.dataSourceToolCalled() && CONNECTION_CLAIM.test(input.answer ?? '')
				? { decision: 'block', reason: STALE_CLAIM_NUDGE }
				: { decision: 'allow' },
	};
}

/** Claiming completed actions with zero tool calls → force a do-or-retract turn. */
export function createActionClaimNudgeHook(deps: { readonly toolsAvailable: boolean; readonly anyToolCall: () => boolean }): IHook {
	return {
		id: 'builtin:action-claim-nudge',
		event: 'Stop',
		run: input => (deps.toolsAvailable && !deps.anyToolCall() && ACTION_CLAIM.test(input.answer ?? '') ? { decision: 'block', reason: ACTION_CLAIM_NUDGE } : { decision: 'allow' }),
	};
}

/** A file-changing run that never wrote a walkthrough → force one. No reply-text condition. */
export function createWalkthroughNudgeHook(deps: {
	readonly walkthroughToolAvailable: boolean;
	readonly filesChanged: () => boolean;
	readonly walkthroughWritten: () => boolean;
}): IHook {
	return {
		id: 'builtin:walkthrough-nudge',
		event: 'Stop',
		run: () => (deps.walkthroughToolAvailable && deps.filesChanged() && !deps.walkthroughWritten() ? { decision: 'block', reason: WALKTHROUGH_NUDGE } : { decision: 'allow' }),
	};
}

// --- W4: live-system discipline (design docs/design/hooks §10 M2) -----------------
// The first M2 discipline hook. A PreToolUse hook on data-source queries that,
// the first time per run, injects a reminder to verify the source is quiescent
// before treating precise counts as a stable snapshot to diff — the exact
// misstep that sent the run-6 diagnosis chasing a moving target (an ES index
// being re-synced live). Inject, never block (Q1): the query still runs; the
// reminder rides its result so the model sees it while looking at the data.

export const LIVE_SYSTEM_NUDGE =
	'<system-reminder>Before treating these counts/rows as a STABLE snapshot to diff or reconcile: is anything WRITING to this data source right now (a running sync, an app under test, a scheduled job)? A concurrent writer makes exact numbers a moving target — a static diff of a live system chases values that change between queries. Verify the source is quiescent, or explicitly account for the churn, before drawing conclusions from precise counts. Report the stable MECHANISM, not a transient count, when the system is live.</system-reminder>';

/** Kill switch: MELLIVORA_LIVE_SYSTEM_NUDGE=off (same pattern as the reply verifier / loop guard). */
export function isLiveSystemNudgeEnabled(env: NodeJS.ProcessEnv): boolean {
	return env['MELLIVORA_LIVE_SYSTEM_NUDGE'] !== 'off';
}

/** Injects the quiescence reminder onto the FIRST data-source query per run (once-per-run via closure state). */
export function createLiveSystemNudgeHook(): IHook {
	let fired = false;
	return {
		id: 'builtin:live-system-nudge',
		event: 'PreToolUse',
		toolMatcher: /^query_data_source$/,
		run: () => {
			if (fired) {
				return { decision: 'allow' };
			}
			fired = true;
			return { decision: 'allow', additionalContext: LIVE_SYSTEM_NUDGE };
		},
	};
}

// --- W2: exploration fan-out discipline (design docs/design/hooks §10 M2) ---------
// The run-6 anti-pattern was 22 serial single-tool exploration turns — the model
// paying the expensive per-turn overhead 22 times to gather things it could have
// fanned out. This PreToolUse hook watches the streak of consecutive single-tool
// exploration turns (counted by the loop) and, once it crosses a threshold,
// injects a reminder to issue parallel spawn_agent calls for independent probes.
// Inject, never block (Q1): serial exploration is sometimes correct (each step
// depending on the last), so this nudges rather than forbids; data-driven
// escalation to a soft block comes only if the reminder proves insufficient.

/** Read-only "gather" tools whose single-tool-per-turn streak signals serial exploration. */
export const EXPLORE_TOOLS: ReadonlySet<string> = new Set(['grep', 'glob', 'list_dir', 'read_symbol', 'bash']);
const EXPLORE_TOOLS_MATCHER = /^(grep|glob|list_dir|read_symbol|bash)$/;

/** After this many consecutive single-exploration-tool turns, the next exploration call gets the fan-out reminder. */
export const FAN_OUT_STREAK_THRESHOLD = 5;

export const FAN_OUT_NUDGE =
	'<system-reminder>You have run several single-step probes in a row. If the remaining things to check are INDEPENDENT (different files, subsystems, or data sources — not each depending on the previous result), issue them as PARALLEL spawn_agent calls in ONE message instead of one tool at a time: it is cheaper and far faster, and keeps your own context clean. Reserve serial tool calls for steps that genuinely need the previous step output.</system-reminder>';

/** Kill switch: MELLIVORA_FANOUT_NUDGE=off. */
export function isFanOutNudgeEnabled(env: NodeJS.ProcessEnv): boolean {
	return env['MELLIVORA_FANOUT_NUDGE'] !== 'off';
}

/** Injects the fan-out reminder once the single-exploration streak crosses the threshold; re-arms when the streak breaks. */
export function createFanOutNudgeHook(deps: { readonly streak: () => number; readonly spawnAvailable: boolean; readonly threshold?: number }): IHook {
	const threshold = deps.threshold ?? FAN_OUT_STREAK_THRESHOLD;
	let nudged = false;
	return {
		id: 'builtin:fanout-nudge',
		event: 'PreToolUse',
		toolMatcher: EXPLORE_TOOLS_MATCHER,
		run: () => {
			if (!deps.spawnAvailable || deps.streak() < threshold) {
				nudged = false; // streak not (yet) over the line — re-arm for next time it crosses.
				return { decision: 'allow' };
			}
			if (nudged) {
				return { decision: 'allow' };
			}
			nudged = true;
			return { decision: 'allow', additionalContext: FAN_OUT_NUDGE };
		},
	};
}

// --- W5: low-yield probe discipline ------------------------------------------
// The "recent request" run's anti-pattern: four consecutive greps in the same
// source area, each returning almost nothing (one measured 82 bytes), because
// the model kept re-searching the same track instead of switching retrieval —
// runtime facts need runtime probes (bash / echo $ENV / listing the data dir),
// not more source greps. This PreToolUse hook watches the streak of consecutive
// single-exploration turns whose result was near-empty (measured by the loop
// after each tool run) and injects a switch-strategy reminder once it crosses
// the threshold. Inject, never block (Q1): a low-yield streak is a hint to
// change approach, not a fault.

/** A single exploration result under this many chars is "no new information". */
export const LOW_YIELD_RESULT_CHARS = 200;

/** After this many consecutive near-empty single-exploration turns, the next probe gets the switch-strategy reminder. */
export const PROBE_STREAK_THRESHOLD = 2;

export const PROBE_BUDGET_NUDGE =
	'<system-reminder>Your recent probes each returned almost nothing — you are re-searching the same place without gathering new information. SWITCH STRATEGY instead of probing harder in the same spot: change the retrieval channel (runtime state via bash / echo $ENV / listing the data dir, rather than more source greps), scope much narrower (path / glob / filesOnly), or ask the user for runtime data only they can see. Two consecutive near-empty results is the signal to change approach.</system-reminder>';

/** Kill switch: MELLIVORA_PROBE_BUDGET_NUDGE=off. */
export function isProbeBudgetNudgeEnabled(env: NodeJS.ProcessEnv): boolean {
	return env['MELLIVORA_PROBE_BUDGET_NUDGE'] !== 'off';
}

/** Injects the switch-strategy reminder once the low-yield streak crosses the threshold; re-arms when it breaks. */
export function createProbeBudgetNudgeHook(deps: { readonly lowYieldStreak: () => number; readonly threshold?: number }): IHook {
	const threshold = deps.threshold ?? PROBE_STREAK_THRESHOLD;
	let nudged = false;
	return {
		id: 'builtin:probe-budget-nudge',
		event: 'PreToolUse',
		toolMatcher: EXPLORE_TOOLS_MATCHER,
		run: () => {
			if (deps.lowYieldStreak() < threshold) {
				nudged = false; // streak reset below the line — re-arm for next time it crosses.
				return { decision: 'allow' };
			}
			if (nudged) {
				return { decision: 'allow' };
			}
			nudged = true;
			return { decision: 'allow', additionalContext: PROBE_BUDGET_NUDGE };
		},
	};
}
