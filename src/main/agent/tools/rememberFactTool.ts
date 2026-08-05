/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineTool } from '../agentTools.js';
import type { IAgentTool } from '../agentTypes.js';
import { asRecord, invalid, valid } from './workspace.js';

/** Cap so a sloppy model can't park a novel in the digest. Keep in sync with workDigest's MAX_FACT_LENGTH. */
export const MAX_FACT_LENGTH = 200;

/**
 * Bookkeeping tool: lets the model persist a CONFIRMED runtime fact (data
 * paths, env vars, ports, data-source locations) into the session work digest,
 * where it rides across runs so a later run starts already knowing it instead
 * of re-deriving it. The tool itself is a no-op — the loop folds the INPUT into
 * the digest via recordWorkDigest — so it must never carry side effects or
 * prompt for approval: it is session bookkeeping, not a user-file mutation.
 */
export function createRememberFactTool(): IAgentTool {
	return defineTool({
		name: 'remember_fact',
		description:
			'Record a CONFIRMED runtime fact about this environment (data paths, env vars, ports, data-source locations) that later turns and later runs would otherwise re-derive. ' +
			'Call it ONCE per fact, only when a tool result actually confirmed it — not for suspicions or plans. ' +
			'Facts ride the session digest across runs, so a future run starts already knowing them. Keep each fact short and self-contained (a future run has none of this context).',
		inputSchema: {
			type: 'object',
			properties: {
				fact: { type: 'string', description: `A short confirmed fact (max ${MAX_FACT_LENGTH} chars), e.g. "data root = ~/.mellivora, run logs in logs/".` },
			},
			required: ['fact'],
			additionalProperties: false,
		},
		// Session bookkeeping only — no user-file mutation, so no permission gate.
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		validateInput: input => {
			const record = asRecord(input);
			if (!record) {
				return invalid('input must be an object');
			}
			if (typeof record.fact !== 'string' || record.fact.trim().length === 0) {
				return invalid('"fact" must be a non-empty string');
			}
			if (record.fact.length > MAX_FACT_LENGTH) {
				return invalid(`"fact" must be at most ${MAX_FACT_LENGTH} characters`);
			}
			return valid(record);
		},
		call: async () => ({ content: 'Fact remembered — it will ride the session digest into later runs.' }),
	});
}
