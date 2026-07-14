/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-run work digest: a deterministic, zero-model summary of what a run
 * actually did — which files it read, wrote, edited, or listed, plus a count of
 * the searches and shell commands it ran.
 *
 * Why it exists: the cross-run transcript keeps only user/assistant TEXT —
 * thinking and tool_use/tool_result blocks are dropped at the run boundary (see
 * toTranscript). That is what keeps the window lean and prompt-cache friendly,
 * but it charges a re-exploration tax: a follow-up run re-reads files the
 * previous run already read (measured up to 7/7 on image follow-ups). The
 * digest pays that tax down for a few hundred characters and ZERO model calls,
 * without reintroducing the full structured tool history the way Claude Code
 * (microcompact) / opencode (prune) do — those age tool blocks WITHIN a live
 * session; this carries a compact fact list ACROSS the run boundary instead.
 *
 * The digest is folded into a hidden `role:'digest'` session message and the
 * NEXT run's transcript carries only the latest one (see toTranscript), so
 * window occupancy stays bounded at a single digest regardless of run count.
 *
 * It is CUMULATIVE across the session: because the previous digest rides the
 * next run's transcript as an assistant turn, the loop seeds a fresh run's
 * accumulator from it ({@link seedWorkDigestFromMessages}) before recording the
 * run's own tools. So the file union grows monotonically and a 3rd-run digest
 * still names files the 1st run read — without any extra persistence, the
 * transcript round-trip IS the carrier.
 */

import type { IAgentMessage } from './agentTypes.js';

/** Cap the per-list file count so a sprawling run can't bloat the digest. */
const MAX_LISTED_FILES = 40;

const DIGEST_OPEN = '<work-digest>';
const DIGEST_CLOSE = '</work-digest>';
/** The label each bucket renders under, and the set it re-seeds into. */
const BUCKET_LABELS = [
	['Read', 'filesRead'],
	['Edited', 'filesEdited'],
	['Wrote', 'filesWritten'],
	['Listed', 'dirsListed'],
] as const;

export interface IWorkDigest {
	readonly filesRead: Set<string>;
	readonly filesWritten: Set<string>;
	readonly filesEdited: Set<string>;
	readonly dirsListed: Set<string>;
	searches: number;
	commands: number;
}

export function createWorkDigest(): IWorkDigest {
	return { filesRead: new Set(), filesWritten: new Set(), filesEdited: new Set(), dirsListed: new Set(), searches: 0, commands: 0 };
}

function inputPath(input: unknown): string | undefined {
	if (typeof input === 'object' && input !== null) {
		const value = (input as { path?: unknown }).path;
		if (typeof value === 'string' && value.trim() !== '') {
			return value;
		}
	}
	return undefined;
}

/**
 * Fold one tool call into the digest. Tool names mirror the workspace tools
 * (readFileTool etc.); unknown tools and malformed inputs are ignored, so a
 * new tool simply doesn't contribute until taught here. Returns whether the
 * call was a tracked tool — the loop uses this to tell a run that DID work
 * (re-persist the cumulative digest) from a purely conversational one (let the
 * previous run's digest ride forward untouched).
 */
export function recordWorkDigest(digest: IWorkDigest, name: string, input: unknown): boolean {
	const path = inputPath(input);
	switch (name) {
		case 'read_file':
			if (path) {
				digest.filesRead.add(path);
			}
			return true;
		case 'write_file':
			if (path) {
				digest.filesWritten.add(path);
			}
			return true;
		case 'edit_file':
			if (path) {
				digest.filesEdited.add(path);
			}
			return true;
		case 'list_dir':
			if (path) {
				digest.dirsListed.add(path);
			}
			return true;
		case 'grep':
		case 'glob':
			digest.searches += 1;
			return true;
		case 'bash':
			digest.commands += 1;
			return true;
		default:
			return false;
	}
}

export interface IWorkDigestSummary {
	readonly filesRead: number;
	/** Written + edited — both are "files this run changed". */
	readonly filesWritten: number;
	readonly toolCalls: number;
}

/** Export-safe counts for telemetry — never any paths or command text. */
export function summarizeWorkDigest(digest: IWorkDigest): IWorkDigestSummary {
	return {
		filesRead: digest.filesRead.size,
		filesWritten: digest.filesWritten.size + digest.filesEdited.size,
		toolCalls: digest.filesRead.size + digest.filesWritten.size + digest.filesEdited.size + digest.dirsListed.size + digest.searches + digest.commands,
	};
}

function formatList(paths: ReadonlySet<string>): string {
	const all = [...paths];
	if (all.length <= MAX_LISTED_FILES) {
		return all.join(', ');
	}
	return `${all.slice(0, MAX_LISTED_FILES).join(', ')}, …+${all.length - MAX_LISTED_FILES} more`;
}

/**
 * Render the digest as a compact hidden block, or undefined when nothing worth
 * carrying was touched (a purely conversational run with no seeded history) —
 * in which case no digest message is emitted at all.
 */
export function buildWorkDigestText(digest: IWorkDigest): string | undefined {
	const lines: string[] = [];
	for (const [label, key] of BUCKET_LABELS) {
		if (digest[key].size > 0) {
			lines.push(`${label}: ${formatList(digest[key])}`);
		}
	}
	const activity: string[] = [];
	if (digest.searches > 0) {
		activity.push(`${digest.searches} search${digest.searches === 1 ? '' : 'es'}`);
	}
	if (digest.commands > 0) {
		activity.push(`${digest.commands} shell command${digest.commands === 1 ? '' : 's'}`);
	}
	if (activity.length > 0) {
		lines.push(`Also ran ${activity.join(', ')}.`);
	}
	if (lines.length === 0) {
		return undefined;
	}
	// Wording matters (learned from a real failure): the digest reaches the
	// model in a LATER run, after the boundary dropped every tool result — so it
	// must read as a map, never as "content you already have". An earlier
	// "no need to re-read" phrasing made the model quote code from memory.
	return `${DIGEST_OPEN}\nFiles explored earlier in this session — NAMES ONLY, their contents are no longer in your context. Use this list to go straight to the right files, but re-read a file before quoting it or making claims about its details:\n${lines.join('\n')}\n${DIGEST_CLOSE}`;
}

/**
 * Re-seed an accumulator from a digest block previously rendered by
 * {@link buildWorkDigestText} — the inverse of the render, so a run inherits
 * every file its predecessors touched. Only file buckets are carried (the
 * activity counts are per-run telemetry, not cumulative); the truncation
 * marker and unparsable lines are ignored, and a body without a digest block
 * is a no-op.
 */
export function seedWorkDigestFromText(digest: IWorkDigest, text: string): void {
	const open = text.indexOf(DIGEST_OPEN);
	const close = text.indexOf(DIGEST_CLOSE, open + DIGEST_OPEN.length);
	if (open === -1 || close === -1) {
		return;
	}
	const body = text.slice(open + DIGEST_OPEN.length, close);
	for (const line of body.split('\n')) {
		const separator = line.indexOf(': ');
		if (separator === -1) {
			continue;
		}
		const label = line.slice(0, separator).trim();
		const bucket = BUCKET_LABELS.find(([name]) => name === label);
		if (!bucket) {
			continue;
		}
		for (const raw of line.slice(separator + 2).split(', ')) {
			const file = raw.trim();
			// Skip the "…+N more" truncation marker — those files are unrecoverable.
			if (file !== '' && !file.startsWith('…+')) {
				digest[bucket[1]].add(file);
			}
		}
	}
}

/** Seed from every text block in a transcript (only the newest digest is present, but union is safe). */
export function seedWorkDigestFromMessages(digest: IWorkDigest, messages: readonly IAgentMessage[]): void {
	for (const message of messages) {
		for (const block of message.content) {
			if (block.type === 'text' && block.text.includes(DIGEST_OPEN)) {
				seedWorkDigestFromText(digest, block.text);
			}
		}
	}
}

/** The loop-event payload (sans `type`), or undefined when nothing was tracked. */
export function buildWorkDigestEvent(
	digest: IWorkDigest,
): { readonly text: string; readonly filesRead: number; readonly filesWritten: number; readonly toolCalls: number } | undefined {
	const text = buildWorkDigestText(digest);
	if (text === undefined) {
		return undefined;
	}
	const summary = summarizeWorkDigest(digest);
	return { text, filesRead: summary.filesRead, filesWritten: summary.filesWritten, toolCalls: summary.toolCalls };
}

/** Kill switch: MELLIVORA_WORK_DIGEST=off (same pattern as the other guards). */
export function isWorkDigestEnabled(env: NodeJS.ProcessEnv): boolean {
	return env['MELLIVORA_WORK_DIGEST'] !== 'off';
}
