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
 */

/** Cap the per-list file count so a sprawling run can't bloat the digest. */
const MAX_LISTED_FILES = 40;

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
 * new tool simply doesn't contribute until taught here.
 */
export function recordWorkDigest(digest: IWorkDigest, name: string, input: unknown): void {
	const path = inputPath(input);
	switch (name) {
		case 'read_file':
			if (path) {
				digest.filesRead.add(path);
			}
			break;
		case 'write_file':
			if (path) {
				digest.filesWritten.add(path);
			}
			break;
		case 'edit_file':
			if (path) {
				digest.filesEdited.add(path);
			}
			break;
		case 'list_dir':
			if (path) {
				digest.dirsListed.add(path);
			}
			break;
		case 'grep':
		case 'glob':
			digest.searches += 1;
			break;
		case 'bash':
			digest.commands += 1;
			break;
		default:
			break;
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
 * Render the digest as a compact hidden block, or undefined when the run
 * touched nothing worth carrying (a purely conversational turn) — in which
 * case no digest message is emitted at all.
 */
export function buildWorkDigestText(digest: IWorkDigest): string | undefined {
	const lines: string[] = [];
	if (digest.filesRead.size > 0) {
		lines.push(`Read: ${formatList(digest.filesRead)}`);
	}
	if (digest.filesEdited.size > 0) {
		lines.push(`Edited: ${formatList(digest.filesEdited)}`);
	}
	if (digest.filesWritten.size > 0) {
		lines.push(`Wrote: ${formatList(digest.filesWritten)}`);
	}
	if (digest.dirsListed.size > 0) {
		lines.push(`Listed: ${formatList(digest.dirsListed)}`);
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
	return `<work-digest>\nMy previous run touched these — no need to re-read them unless they may have changed:\n${lines.join('\n')}\n</work-digest>`;
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
