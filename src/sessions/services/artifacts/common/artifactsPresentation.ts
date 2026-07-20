/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ArtifactKind, IArtifactEntryData } from './artifacts.js';

/**
 * Pure presentation helpers for the artifacts panel (#13 P1) — kept in common
 * (no DOM) so the bare-node unit tests can exercise grouping and the icon map
 * without a renderer.
 */

export interface IArtifactSessionGroup {
	readonly sessionId: string;
	readonly entries: readonly IArtifactEntryData[];
}

/**
 * Group by producing session, newest first everywhere: groups are ordered by
 * their latest artifact, rows inside a group by their own createdAt — the top
 * of the panel is always "what just happened".
 */
export function groupArtifactsBySession(entries: readonly IArtifactEntryData[]): readonly IArtifactSessionGroup[] {
	const bySession = new Map<string, IArtifactEntryData[]>();
	for (const entry of entries) {
		const group = bySession.get(entry.sessionId);
		if (group) {
			group.push(entry);
		} else {
			bySession.set(entry.sessionId, [entry]);
		}
	}
	const groups: IArtifactSessionGroup[] = [];
	for (const [sessionId, group] of bySession) {
		group.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
		groups.push({ sessionId, entries: group });
	}
	return groups.sort((a, b) => b.entries[0]!.createdAt.localeCompare(a.entries[0]!.createdAt) || a.sessionId.localeCompare(b.sessionId));
}

/** One codicon per kind; the exhaustive switch makes a new ArtifactKind a compile error here. */
export function artifactKindIcon(kind: ArtifactKind): string {
	switch (kind) {
		case 'plan':
			return 'codicon-checklist';
		case 'walkthrough':
			return 'codicon-book';
		case 'ui-card':
			return 'codicon-layout';
		case 'table':
			return 'codicon-table';
		case 'export':
			return 'codicon-save';
		case 'document':
			return 'codicon-file-text';
		case 'change-set':
			return 'codicon-diff';
	}
}
