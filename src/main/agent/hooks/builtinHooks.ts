/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IModelClient } from '../agentTypes.js';
import { buildRetryFeedback, verifyReply } from '../replyVerifier.js';
import type { IHook, IHookDecision, IHookInput } from './hooks.js';

/**
 * Built-in hooks: the hardcoded interceptions of agentLoop, re-expressed as
 * registered hooks (design §7 migration). This file starts the migration with
 * the reply verifier — the one that already calls itself "Modeled on CC's Stop
 * hook". Behavior is preserved: fail → block with the same retry feedback,
 * pass/error → allow (fail-open). The verdict rides `note` so the loop can
 * still emit its `reply_verifier` observability event when this hook is wired
 * in (the wiring is the next increment; this adapter proves the shape).
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
			if (verification.verdict === 'fail') {
				return {
					decision: 'block',
					reason: buildRetryFeedback(input.question, verification.reason),
					note: `verdict=fail${verification.reason ? ` reason=${verification.reason}` : ''}`,
				};
			}
			// pass, or error (fail-open — a broken judge never harms a normal reply).
			return { decision: 'allow', note: `verdict=${verification.verdict}` };
		},
	};
}
