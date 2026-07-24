/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure render-model derivation for work blocks (#14 P0). Everything here is a
 * function of persisted step facts — no clocks, no state — so replaying a
 * stored session renders identically to the live run (Q3's replay constraint),
 * and old sessions render through the same path via the label fallback.
 */

import { localize, type MessageKey } from '../../../../common/i18n/i18n.js';
import { SUBAGENT_END_ARG_PREFIX, type ISessionWorkStep } from '../../../../services/sessions/common/session.js';

/** Tool → i18n verb key. Kept as data (not localize calls) so this module stays pure and node-testable. */
export const TOOL_VERB_KEYS: Readonly<Record<string, MessageKey>> = {
	read_file: 'workVerb.read_file',
	write_file: 'workVerb.write_file',
	edit_file: 'workVerb.edit_file',
	list_dir: 'workVerb.list_dir',
	glob: 'workVerb.glob',
	grep: 'workVerb.grep',
	bash: 'workVerb.bash',
	run_on_server: 'workVerb.run_on_server',
	upload_to_server: 'workVerb.upload_to_server',
	list_servers: 'workVerb.list_servers',
	list_data_sources: 'workVerb.list_data_sources',
	query_data_source: 'workVerb.query_data_source',
	execute_data_source: 'workVerb.execute_data_source',
	render_data: 'workVerb.render_data',
	render_ui: 'workVerb.render_ui',
	propose_plan: 'workVerb.propose_plan',
	update_plan: 'workVerb.update_plan',
	write_walkthrough: 'workVerb.write_walkthrough',
	spawn_agent: 'workVerb.spawn_agent',
	subagent: 'workVerb.subagent',
};

/** Read-class tools fold into rollups; the class picks which counter they bump. */
const READ_CLASS: Readonly<Record<string, 'file' | 'dir' | 'search'>> = {
	read_file: 'file',
	list_dir: 'dir',
	glob: 'search',
	grep: 'search',
};

/** How one step renders: structured verb+chip when facts exist, legacy label otherwise. */
export interface IWorkStepPresentation {
	/** i18n key for the intent verb; undefined → render the legacy `label` as-is. */
	readonly verbKey?: MessageKey;
	/** Chip text beside the verb (path / command / pattern…). */
	readonly chip?: string;
	/** Failed tool call — legacy records are recognized by their '[error]' detail marker. */
	readonly error: boolean;
	/** Ran inside a spawned child loop — the row keeps the ⑃ marker. */
	readonly sub?: boolean;
}

/**
 * The tool a step ran, recovered for legacy records from the label's
 * `${name} ${arg}` shape (describeWorkTool's stable format since day one) —
 * old sessions get verbs and rollups without any migration.
 */
export function stepTool(step: ISessionWorkStep): string | undefined {
	if (step.tool !== undefined) {
		return step.tool;
	}
	if (step.kind !== 'tool') {
		return undefined;
	}
	const name = step.label.split(' ', 1)[0] ?? '';
	return TOOL_VERB_KEYS[name] !== undefined ? name : undefined;
}

/** The chip argument, from facts or recovered from a legacy label. */
export function stepArg(step: ISessionWorkStep): string | undefined {
	if (step.arg !== undefined) {
		return step.arg;
	}
	const tool = stepTool(step);
	if (tool === undefined || step.tool !== undefined) {
		return undefined;
	}
	const rest = step.label.slice(tool.length).trim();
	return rest === '' ? undefined : rest;
}

export function stepError(step: ISessionWorkStep): boolean {
	return step.outcome === 'error' || (step.outcome === undefined && step.detail !== undefined && step.detail.startsWith('[error]'));
}

export function presentStep(step: ISessionWorkStep): IWorkStepPresentation {
	const error = stepError(step);
	const tool = stepTool(step);
	if (tool === undefined) {
		return { error };
	}
	const verbKey = TOOL_VERB_KEYS[tool];
	if (verbKey === undefined) {
		return { error };
	}
	const chip = stepArg(step);
	return { verbKey, ...(chip === undefined ? {} : { chip }), error, ...(step.via === 'subagent' ? { sub: true } : {}) };
}

/** One rendered row: a plain step, or a rollup of consecutive read-class steps. */
export type WorkRenderItem =
	| { readonly kind: 'step'; readonly step: ISessionWorkStep; readonly index: number }
	| {
			readonly kind: 'rollup';
			/** The folded steps, original indices preserved for stable React keys. */
			readonly steps: readonly { readonly step: ISessionWorkStep; readonly index: number }[];
			/** Distinct files read (deduped by arg; argless reads count individually). */
			readonly files: number;
			/** Distinct directories listed. */
			readonly dirs: number;
			/** Search invocations (glob + grep), occurrences not deduped. */
			readonly searches: number;
			/** Sum of member durations. */
			readonly durationMs: number;
			/** The trailing member is the run's open call — the rollup carries the spinner. */
			readonly running: boolean;
	  };

/**
 * Fold consecutive successful read-class tool steps (Q2's converged industry
 * rule): any non-read tool call — a write, an error, an unknown tool — breaks
 * the run; writes never aggregate; a lone read stays a plain row. Thinking
 * does NOT break a run (see the 2a note below). Counters are derived from an
 * append-only array, so they are monotonic within a run by construction.
 */
export function buildWorkRenderItems(steps: readonly ISessionWorkStep[]): WorkRenderItem[] {
	const items: WorkRenderItem[] = [];
	let group: { step: ISessionWorkStep; index: number }[] = [];
	// 2a: thinking never breaks a read run — k3 thinks between every turn and
	// breaking on it shredded rollups back into an alternating wall. Thinking
	// rows met inside an open group re-emit right after it closes.
	let deferredThinking: { step: ISessionWorkStep; index: number }[] = [];

	const flush = (): void => {
		if (group.length === 0) {
			if (deferredThinking.length > 0) {
				for (const entry of deferredThinking) {
					items.push({ kind: 'step', step: entry.step, index: entry.index });
				}
				deferredThinking = [];
			}
			return;
		}
		if (group.length === 1) {
			items.push({ kind: 'step', step: group[0]!.step, index: group[0]!.index });
		} else {
			const seenFiles = new Set<string>();
			const seenDirs = new Set<string>();
			let files = 0;
			let dirs = 0;
			let searches = 0;
			let durationMs = 0;
			for (const member of group) {
				durationMs += member.step.durationMs;
				const cls = READ_CLASS[stepTool(member.step) ?? ''];
				const arg = stepArg(member.step);
				if (cls === 'file') {
					if (arg === undefined) {
						files += 1;
					} else if (!seenFiles.has(arg)) {
						seenFiles.add(arg);
						files += 1;
					}
				} else if (cls === 'dir') {
					if (arg === undefined) {
						dirs += 1;
					} else if (!seenDirs.has(arg)) {
						seenDirs.add(arg);
						dirs += 1;
					}
				} else if (cls === 'search') {
					searches += 1;
				}
			}
			items.push({ kind: 'rollup', steps: group, files, dirs, searches, durationMs, running: group[group.length - 1]!.step.running === true });
		}
		group = [];
		for (const entry of deferredThinking) {
			items.push({ kind: 'step', step: entry.step, index: entry.index });
		}
		deferredThinking = [];
	};

	for (let index = 0; index < steps.length; index++) {
		const step = steps[index]!;
		const cls = step.kind === 'tool' ? READ_CLASS[stepTool(step) ?? ''] : undefined;
		if (cls !== undefined && !stepError(step)) {
			// Parallel children interleave chronologically — a group never spans
			// agents (or mixes a child with the main loop), so each sweep stays
			// attributable even when the fold hides the individual rows.
			if (group.length > 0 && group[group.length - 1]!.step.agent !== step.agent) {
				flush();
			}
			group.push({ step, index });
		} else if (step.kind === 'thinking' && group.length > 0) {
			deferredThinking.push({ step, index });
		} else {
			flush();
			items.push({ kind: 'step', step, index });
		}
	}
	flush();
	return items;
}

/** A child loop's sub-block inside a section: its steps de-interleaved from siblings, so rollups fold whole sweeps again. */
export interface IWorkAgentGroup {
	readonly kind: 'agentGroup';
	readonly agent: string;
	/** Header text. With ≥2 sibling groups this is the SHORT form — `子代理 n · <去公共前缀的区分段>` — because parallel shards share near-identical task briefs and six identical 72-char headers distinguish nothing (2026-07-20 screenshot). */
	readonly label: string;
	/** The full spawn task, for the hover title when `label` is the short form. */
	readonly fullLabel?: string;
	/** Inner render items — the child's own steps, rollups applied. */
	readonly items: readonly WorkRenderItem[];
	/** The spawn call's real runtime, once its result closed. */
	readonly durationMs?: number;
	readonly running: boolean;
	readonly error: boolean;
	/** "12 turns · 47 tool calls · 239k tokens" from the end step. */
	readonly endDetail?: string;
	/** Ordering anchor and stable React key: the group's first step index. */
	readonly firstIndex: number;
}

export type WorkSectionItem = WorkRenderItem | IWorkAgentGroup;

/** The whole work block's render items, with parallel child loops de-interleaved into their own groups. */
export interface IWorkSection {
	readonly items: readonly WorkSectionItem[];
	readonly firstIndex: number;
}

/**
 * The #14 P1 render model: each child loop's steps collapse into ONE agent
 * group anchored at the child's first appearance (de-interleaving parallel
 * children); the remaining main-loop stretches run through the rollup fold.
 * Pure function of persisted facts — replay renders identically to the live run.
 */
export function buildWorkSections(steps: readonly ISessionWorkStep[]): IWorkSection[] {
	const sections: IWorkSection[] = [];
	const sectionFirst = 0;
	// An ordered token list of main-loop stretches and agent buckets, buckets
	// keyed by agent and anchored at first appearance.
	type Token = { kind: 'main'; steps: { step: ISessionWorkStep; index: number }[] } | { kind: 'bucket'; agent: string; firstIndex: number };
	const tokens: Token[] = [];
	const buckets = new Map<string, { firstIndex: number; label?: string; durationMs?: number; running: boolean; error: boolean; endDetail?: string; members: ISessionWorkStep[] }>();

	const flushSection = (): void => {
		if (tokens.length === 0) {
			return;
		}
		const items: WorkSectionItem[] = [];
		for (const token of tokens) {
			if (token.kind === 'main') {
				items.push(...buildWorkRenderItemsIndexed(token.steps));
			} else {
				const bucket = buckets.get(token.agent)!;
				items.push({
					kind: 'agentGroup',
					agent: token.agent,
					label: bucket.label ?? localize('workVerb.subagent'),
					...(bucket.label !== undefined ? { fullLabel: bucket.label } : {}),
					items: buildWorkRenderItems(bucket.members),
					...(bucket.durationMs === undefined ? {} : { durationMs: bucket.durationMs }),
					running: bucket.running,
					error: bucket.error,
					...(bucket.endDetail === undefined ? {} : { endDetail: bucket.endDetail }),
					firstIndex: bucket.firstIndex,
				});
			}
		}
		shortenSiblingAgentLabels(items);
		sections.push({ items, firstIndex: sectionFirst });
	};

	for (let index = 0; index < steps.length; index++) {
		const step = steps[index]!;
		const agent = step.kind === 'tool' ? step.agent : undefined;
		if (agent !== undefined) {
			let bucket = buckets.get(agent);
			if (bucket === undefined) {
				bucket = { firstIndex: index, running: false, error: false, members: [] };
				buckets.set(agent, bucket);
				tokens.push({ kind: 'bucket', agent, firstIndex: index });
			}
			const tool = stepTool(step);
			if (tool === 'spawn_agent') {
				// Marker (closed at subagent_start, no outcome) names the group;
				// the RESULT (has an outcome + real durationMs) times it; a running
				// synthetic shows the child's current action as a live row.
				if (step.running === true) {
					bucket.running = true;
					// The synthetic live row: its LABEL carries the child's current
					// activity (⑃ grep … / 撰写结论中 · 3.4k 字). Before any child
					// event takes the label over it still echoes the raw task —
					// pure noise under a header that already shows the task, so it
					// only renders once the label has moved on.
					if (step.label !== `spawn_agent ${step.arg ?? ''}`.trim()) {
						bucket.members.push(step);
					}
				} else if (step.outcome !== undefined) {
					bucket.durationMs = step.durationMs;
					bucket.error = bucket.error || stepError(step);
				} else if (step.arg !== undefined) {
					bucket.label = step.arg;
				}
			} else if (tool === 'subagent' && step.arg !== undefined && step.arg.startsWith(SUBAGENT_END_ARG_PREFIX)) {
				if (step.detail !== undefined) {
					bucket.endDetail = step.detail;
				}
			} else {
				bucket.error = bucket.error || stepError(step);
				bucket.running = bucket.running || step.running === true;
				bucket.members.push(step);
			}
		} else {
			const last = tokens[tokens.length - 1];
			if (last !== undefined && last.kind === 'main') {
				last.steps.push({ step, index });
			} else {
				tokens.push({ kind: 'main', steps: [{ step, index }] });
			}
		}
	}
	flushSection();
	return sections;
}

/** buildWorkRenderItems over a pre-indexed slice, preserving original indices for stable keys. */
function buildWorkRenderItemsIndexed(members: readonly { step: ISessionWorkStep; index: number }[]): WorkRenderItem[] {
	const items = buildWorkRenderItems(members.map(member => member.step));
	// Remap local indices back to the original step positions.
	return items.map(item =>
		item.kind === 'step' ? { ...item, index: members[item.index]!.index } : { ...item, steps: item.steps.map(entry => ({ step: entry.step, index: members[entry.index]!.index })) },
	);
}

/**
 * Parallel shards share near-identical task briefs; six identical truncated
 * headers distinguish nothing. With ≥2 sibling groups the headers become
 * `子代理 n · <后缀>` where the suffix is each task minus the siblings' longest
 * common prefix — exactly the per-shard分工 the truncation used to hide. The
 * full task stays on `fullLabel` (hover). Mutates in place on the freshly
 * built section items (they are local until pushed).
 */
function shortenSiblingAgentLabels(items: WorkSectionItem[]): void {
	const groups = items.filter((item): item is IWorkAgentGroup => item.kind === 'agentGroup' && item.fullLabel !== undefined);
	if (groups.length < 2) {
		return;
	}
	const labels = groups.map(group => group.fullLabel!);
	let prefix = labels[0]!;
	for (const label of labels) {
		let length = 0;
		const max = Math.min(prefix.length, label.length);
		while (length < max && prefix[length] === label[length]) {
			length++;
		}
		prefix = prefix.slice(0, length);
	}
	// A short shared prefix ("探索") is semantic, not boilerplate — strip only
	// when the prefix is substantial; the ordinal always rides for scanning.
	const strip = prefix.length >= 8;
	for (let index = 0; index < groups.length; index++) {
		const group = groups[index]!;
		const suffix = strip ? group.fullLabel!.slice(prefix.length).trim() : group.fullLabel!;
		const distinct = suffix === '' ? group.fullLabel! : suffix;
		const bounded = distinct.length > 48 ? `${distinct.slice(0, 48)}…` : distinct;
		(group as { label: string }).label = localize('work.agentOrdinal', index + 1, bounded);
	}
}
