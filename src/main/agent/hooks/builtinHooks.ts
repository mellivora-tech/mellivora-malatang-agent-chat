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
