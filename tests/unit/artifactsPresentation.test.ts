/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import type { ArtifactKind, IArtifactEntryData } from '../../src/sessions/services/artifacts/common/artifacts.js';
import { artifactKindIcon, groupArtifactsBySession } from '../../src/sessions/services/artifacts/common/artifactsPresentation.js';

function entry(overrides: Partial<IArtifactEntryData> & { readonly id: string; readonly sessionId: string; readonly createdAt: string }): IArtifactEntryData {
	return {
		kind: 'plan',
		title: 't',
		payload: { type: 'message', messageId: 'm' },
		...overrides,
	};
}

test('groupArtifactsBySession: groups by latest artifact desc, rows newest-first inside a group', () => {
	const groups = groupArtifactsBySession([
		entry({ id: 'a:1', sessionId: 'a', createdAt: '2026-07-20T10:00:00.000Z' }),
		entry({ id: 'b:1', sessionId: 'b', createdAt: '2026-07-20T11:00:00.000Z' }),
		entry({ id: 'a:2', sessionId: 'a', createdAt: '2026-07-20T12:00:00.000Z' }),
	]);

	assert.deepEqual(
		groups.map(group => group.sessionId),
		['a', 'b'],
	);
	assert.deepEqual(
		groups[0]!.entries.map(row => row.id),
		['a:2', 'a:1'],
	);
});

test('groupArtifactsBySession: identical timestamps fall back to deterministic id order', () => {
	const at = '2026-07-20T10:00:00.000Z';
	const groups = groupArtifactsBySession([
		entry({ id: 'b:1', sessionId: 'b', createdAt: at }),
		entry({ id: 'a:1', sessionId: 'a', createdAt: at }),
		entry({ id: 'a:0', sessionId: 'a', createdAt: at }),
	]);

	assert.deepEqual(
		groups.map(group => group.sessionId),
		['a', 'b'],
	);
	assert.deepEqual(
		groups[0]!.entries.map(row => row.id),
		['a:1', 'a:0'],
	);
});

test('artifactKindIcon covers every kind with a codicon', () => {
	const kinds: readonly ArtifactKind[] = ['plan', 'walkthrough', 'ui-card', 'table', 'export', 'document', 'change-set'];
	for (const kind of kinds) {
		assert.match(artifactKindIcon(kind), /^codicon-[a-z-]+$/, kind);
	}
	assert.equal(artifactKindIcon('plan'), 'codicon-checklist');
	assert.equal(artifactKindIcon('export'), 'codicon-save');
});
