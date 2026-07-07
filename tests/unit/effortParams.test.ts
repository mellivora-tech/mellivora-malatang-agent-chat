/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import type { IModelRequest } from '../../src/main/agent/agentTypes.js';
import { buildAnthropicRequestBody } from '../../src/main/agent/anthropicModelClient.js';
import { buildOpenAIRequestBody } from '../../src/main/agent/openaiModelClient.js';

function request(): IModelRequest {
	return { system: 'be helpful', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], signal: new AbortController().signal };
}

test('openai-compatible: effort maps to reasoning_effort; omitted = not sent', () => {
	const withEffort = buildOpenAIRequestBody({ baseURL: 'https://x/v1', model: 'gpt-5.5', params: { effort: 'high' } }, request());
	assert.equal(withEffort['reasoning_effort'], 'high');

	const withoutEffort = buildOpenAIRequestBody({ baseURL: 'https://x/v1', model: 'gpt-5.5' }, request());
	assert.ok(!('reasoning_effort' in withoutEffort));
});

test('anthropic: effort maps to output_config.effort; omitted = not sent', () => {
	const withEffort = buildAnthropicRequestBody({ baseURL: 'https://x', model: 'claude-opus-4-8', params: { effort: 'max' } }, request());
	assert.deepEqual(withEffort['output_config'], { effort: 'max' });

	const withoutEffort = buildAnthropicRequestBody({ baseURL: 'https://x', model: 'claude-opus-4-8' }, request());
	assert.ok(!('output_config' in withoutEffort));
});
