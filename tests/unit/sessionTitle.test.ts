/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import type { IModelClient, IModelRequest, IModelStreamEvent } from '../../src/main/agent/agentTypes.js';
import { generateSessionTitle, sanitizeSessionTitle } from '../../src/main/agent/sessionTitle.js';

function scriptedClient(events: readonly IModelStreamEvent[], onRequest?: (request: IModelRequest) => void): IModelClient {
	return {
		async *stream(request) {
			onRequest?.(request);
			yield* events;
		},
	};
}

test('sanitizeSessionTitle strips quotes, trailing punctuation, and extra lines', () => {
	assert.equal(sanitizeSessionTitle('"项目结构梳理。"\n多余的解释'), '项目结构梳理');
	assert.equal(sanitizeSessionTitle('  Fix the   greeting timer!  '), 'Fix the greeting timer');
	assert.equal(sanitizeSessionTitle('“评估项目成熟度”'), '评估项目成熟度');
});

test('sanitizeSessionTitle caps overly long titles and rejects empty output', () => {
	const long = 'x'.repeat(200);
	assert.equal(sanitizeSessionTitle(long)?.length, 60);
	assert.equal(sanitizeSessionTitle('   '), undefined);
	assert.equal(sanitizeSessionTitle('"。！"'), undefined);
});

test('generateSessionTitle collects text deltas and sanitizes the result', async () => {
	const client = scriptedClient([
		{ type: 'text_delta', text: '"梳理项目' },
		{ type: 'text_delta', text: '结构"。' },
		{ type: 'message_stop', stopReason: 'end_turn' },
	]);
	const title = await generateSessionTitle(client, '梳理下当前项目', new AbortController().signal);
	assert.equal(title, '梳理项目结构');
});

test('generateSessionTitle sends no tools and truncates a huge first message', async () => {
	let seen: IModelRequest | undefined;
	const client = scriptedClient([{ type: 'text_delta', text: 'Imported toll report' }], request => {
		seen = request;
	});
	const query = `/api/toll/report/import ${'{"data": 1}'.repeat(1000)}`;
	const title = await generateSessionTitle(client, query, new AbortController().signal);
	assert.equal(title, 'Imported toll report');
	assert.ok(seen, 'the model was called');
	assert.equal(seen.tools.length, 0, 'a title call carries no tools');
	const block = seen.messages[0]?.content[0];
	assert.ok(block?.type === 'text' && block.text.length <= 2000, 'the query is truncated before it rides the request');
});

test('generateSessionTitle returns undefined when the model yields no text', async () => {
	const client = scriptedClient([{ type: 'message_stop', stopReason: 'end_turn' }]);
	assert.equal(await generateSessionTitle(client, 'hello', new AbortController().signal), undefined);
});
