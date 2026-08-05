/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldRenderCompactApproval } from '../../src/sessions/browser/parts/approvalDock.js';

test('early prompts render the full card; density drops after the threshold', () => {
	// The first few prompts stay full so the user reads the ceremony at least once.
	assert.equal(shouldRenderCompactApproval(0, 'bash'), false);
	assert.equal(shouldRenderCompactApproval(1, 'bash'), false);
	assert.equal(shouldRenderCompactApproval(2, 'bash'), false);
	// From the 4th prompt on (3 already answered), the card compacts.
	assert.equal(shouldRenderCompactApproval(3, 'bash'), true);
	assert.equal(shouldRenderCompactApproval(10, 'bash'), true);
});

test('file tools compact after the threshold too', () => {
	assert.equal(shouldRenderCompactApproval(3, 'write_file'), true);
	assert.equal(shouldRenderCompactApproval(3, 'edit_file'), true);
	assert.equal(shouldRenderCompactApproval(2, 'write_file'), false);
});

test('SAFETY: tools whose only gate is the prompt itself never compact', () => {
	// run_on_server / upload_to_server (SSH, incl. prod) have no inner guard —
	// their approval card must never shrink, no matter how dense the run gets.
	assert.equal(shouldRenderCompactApproval(100, 'run_on_server'), false);
	assert.equal(shouldRenderCompactApproval(100, 'upload_to_server'), false);
	assert.equal(shouldRenderCompactApproval(100, 'query_data_source'), false);
	assert.equal(shouldRenderCompactApproval(100, 'unknown_tool'), false);
});
