/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { listReferencableSessions } from '../../src/sessions/browser/parts/conversationView.js';
import type { ISession } from '../../src/sessions/services/sessions/common/session.js';

function stubSession(sessionId: string, title: string, updatedAt: string, isArchived = false): ISession {
	return {
		sessionId,
		title: { get: () => title },
		updatedAt: { get: () => new Date(updatedAt) },
		isArchived: { get: () => isArchived },
	} as never;
}

test('listReferencableSessions excludes the current and archived sessions, newest first, capped', () => {
	const sessions = [
		stubSession('current', 'Me', '2026-07-10T10:00:00Z'),
		stubSession('old', 'Old task', '2026-07-01T10:00:00Z'),
		stubSession('new', 'New task', '2026-07-09T10:00:00Z'),
		stubSession('archived', 'Archived', '2026-07-08T10:00:00Z', true),
	];
	const entries = listReferencableSessions(sessions, 'current');
	assert.deepEqual(
		entries.map(entry => entry.id),
		['new', 'old'],
	);
	assert.equal(entries[0]!.name, 'New task');

	assert.equal(listReferencableSessions(sessions, 'current', 1).length, 1, 'the cap is honored');
});
