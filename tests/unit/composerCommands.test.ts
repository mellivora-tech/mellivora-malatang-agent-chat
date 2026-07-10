/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { filterCommands, findCommandQuery, type IComposerCommand } from '../../src/sessions/browser/parts/composerCommands.js';

test('findCommandQuery only fires on a leading slash with the caret inside the first word', () => {
	assert.equal(findCommandQuery('/', 1), '');
	assert.equal(findCommandQuery('/fo', 3), 'fo');
	assert.equal(findCommandQuery('/fork now', 9), undefined, 'whitespace ends the token');
	assert.equal(findCommandQuery('see src/a.ts', 12), undefined, 'a path slash mid-message is not a command');
	assert.equal(findCommandQuery('/fork', 0), undefined, 'caret before the slash sees no token');
});

test('filterCommands ranks prefix matches above substring matches', () => {
	const commands: IComposerCommand[] = [
		{ name: 'review', kind: 'template', description: 'Review changes', template: 'x' },
		{ name: 'fork', kind: 'action', description: 'Fork the conversation' },
		{ name: 'fix', kind: 'template', description: 'Run checks and fix failures', template: 'y' },
	];
	assert.deepEqual(
		filterCommands(commands, 'f').map(command => command.name),
		['fork', 'fix'],
	);
	assert.deepEqual(
		filterCommands(commands, 'fix').map(command => command.name),
		['fix'],
		'description matches trail name matches',
	);
	assert.equal(filterCommands(commands, '').length, 3);
});
