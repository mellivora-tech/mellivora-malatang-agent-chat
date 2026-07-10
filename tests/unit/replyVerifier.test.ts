/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRetryFeedback, isReplyVerifierEnabled, parseVerdict, verifyReply } from '../../src/main/agent/replyVerifier.js';
import type { IModelClient, IModelStreamEvent } from '../../src/main/agent/agentTypes.js';

function judgeClient(output: string): IModelClient {
	return {
		async *stream(): AsyncGenerator<IModelStreamEvent, void> {
			yield { type: 'thinking_delta', text: 'judge pondering — must be ignored by the parser' };
			yield { type: 'text_delta', text: output };
			yield { type: 'message_stop', stopReason: 'end_turn' };
		},
	};
}

const signal = new AbortController().signal;

test('parseVerdict: YES/NO first line decides; anything else is a judge malfunction', () => {
	assert.equal(parseVerdict('YES\nreply covers the question').verdict, 'pass');
	assert.equal(parseVerdict('  no \nwrong topic entirely').verdict, 'fail');
	assert.equal(parseVerdict('No.').verdict, 'fail');
	assert.equal(parseVerdict('MAYBE — hard to say').verdict, 'error');
	assert.equal(parseVerdict('').verdict, 'error');
});

test('verifyReply: fail carries the reason; thinking deltas never reach the parser', async () => {
	const result = await verifyReply({ client: judgeClient('NO\ntalks about weather, not tokens'), question: 'q', answer: 'a', signal });
	assert.equal(result.verdict, 'fail');
	assert.match(result.reason, /weather/);
});

test('verifyReply: a throwing judge is fail-open (verdict error, never fail)', async () => {
	const throwing: IModelClient = {
		// eslint-disable-next-line require-yield
		async *stream(): AsyncGenerator<IModelStreamEvent, void> {
			throw new Error('judge unavailable');
		},
	};
	const result = await verifyReply({ client: throwing, question: 'q', answer: 'a', signal });
	assert.equal(result.verdict, 'error');
	assert.match(result.reason, /unavailable/);
});

test('kill switch: MELLIVORA_REPLY_VERIFIER=off disables, anything else enables', () => {
	assert.equal(isReplyVerifierEnabled({ MELLIVORA_REPLY_VERIFIER: 'off' }), false);
	assert.equal(isReplyVerifierEnabled({}), true);
	assert.equal(isReplyVerifierEnabled({ MELLIVORA_REPLY_VERIFIER: 'on' }), true);
});

test('buildRetryFeedback quotes the question and the reviewer note', () => {
	const feedback = buildRetryFeedback('what is the token timeout?', 'reply was about pending work');
	assert.match(feedback, /Reply verifier/);
	assert.match(feedback, /token timeout/);
	assert.match(feedback, /pending work/);
});
