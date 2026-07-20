/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Data contracts for the artifacts index (#13 P0), shared between the main
 * process and the renderer. Pure JSON shapes, no electron/DOM imports — the
 * bare-node unit tests import this file.
 *
 * The session transcript stays the single source of truth: the index is an
 * append-only acceleration mirror that can always be rebuilt by scanning the
 * session files, so it carries no consistency responsibility of its own.
 */

/** 'change-set' and 'document' are reserved for later phases (#13 P2 / 长答案分流) — no producer writes them yet. */
export type ArtifactKind = 'plan' | 'walkthrough' | 'ui-card' | 'table' | 'export' | 'change-set' | 'document';

/**
 * Where the artifact's body lives. 'message' points back into the transcript
 * (the truth); 'media' and 'export' are file paths — 'export' paths are outside
 * the data root and exist ONLY in the index (they cannot be rebuilt).
 */
export type IArtifactPayloadData =
	{ readonly type: 'message'; readonly messageId: string } | { readonly type: 'media'; readonly path: string } | { readonly type: 'export'; readonly path: string };

export interface IArtifactEntryData {
	/** Stable across rebuilds: `${sessionId}:${messageId}` for message payloads, derived from the file name/path for media/export payloads. */
	readonly id: string;
	readonly kind: ArtifactKind;
	readonly sessionId: string;
	readonly projectId?: string;
	readonly title: string;
	/** ISO timestamp. */
	readonly createdAt: string;
	readonly payload: IArtifactPayloadData;
	/** A plan replaced by a newer version; set via a patch line, never unset. */
	readonly superseded?: boolean;
}

/**
 * A patch line appended when a plan is superseded — folded onto the entry with
 * the same id. `projectId` only routes the line to the right index file; a
 * patch that never meets its entry (deleted session) folds to nothing.
 */
export interface IArtifactPatchData {
	readonly id: string;
	readonly superseded: true;
	readonly projectId?: string;
}

/** One line of an artifacts.jsonl file. Patch lines have no `kind`. */
export type IArtifactLineData = IArtifactEntryData | IArtifactPatchData;

export interface IArtifactFilter {
	readonly projectId?: string;
	readonly sessionId?: string;
}

/** The shape exposed on `agentWindow.artifacts` by the preload script. */
export interface IArtifactsBridge {
	list(filter?: IArtifactFilter): Promise<readonly IArtifactEntryData[]>;
	/** Rebuild one scope's index from its session transcripts (projectId absent = the projectless scope). */
	rebuild(projectId?: string): Promise<void>;
	/** Show an export-payload path in the OS file manager; false = the file is gone (the panel marks the row stale). */
	reveal(path: string): Promise<boolean>;
}
