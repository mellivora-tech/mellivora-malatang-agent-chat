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

/**
 * Shell commands that only READ. A bash step whose whole command (pipes
 * included) consists of these folds into read-class rollups (2026-08-05 工具
 * 合并渲染): the dedup-detour pattern (read_file rejected → `cat` via bash)
 * is semantically exploration and should fold like one.
 */
const READONLY_SHELL_COMMANDS: Readonly<Record<string, 'file' | 'dir' | 'search'>> = {
	cat: 'file',
	head: 'file',
	tail: 'file',
	sed: 'file',
	ls: 'dir',
	grep: 'search',
	egrep: 'search',
	fgrep: 'search',
	find: 'search',
	wc: 'search',
	echo: 'search',
	pwd: 'search',
	diff: 'search',
	git: 'search',
};

/** git subcommands that never mutate. Anything else (push, checkout, clean…) disqualifies the whole command. */
const READONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(['status', 'diff', 'log', 'show', 'blame', 'grep', 'ls-files', 'rev-parse', 'branch', 'remote']);

/**
 * Classify a shell command as read-only exploration — or refuse. Fail-closed:
 * anything we can't PROVE read-only (`>`/`>>` redirects, `&&`/`;` chains,
 * command substitution, `tee`, `sed -i`, non-whitelisted commands) returns
 * undefined and the step stays an unfolded row. Writes must never hide in a
 * fold. Pure function of the persisted arg, so replay classifies identically.
 */
export function classifyShellRead(command: string): 'file' | 'dir' | 'search' | undefined {
	// Redirects, chains, substitutions: unprovable → out. (Pipes are fine —
	// each segment is checked on its own below.)
	if (/[>;`]|&&|\|\||\$\(|\btee\b/.test(command)) {
		return undefined;
	}
	let result: 'file' | 'dir' | 'search' | undefined;
	for (const segment of command.split('|')) {
		const tokens = segment.trim().split(/\s+/);
		const cmd = tokens[0] ?? '';
		const cls = READONLY_SHELL_COMMANDS[cmd];
		if (cls === undefined) {
			return undefined;
		}
		if (cmd === 'sed' && tokens.includes('-i')) {
			return undefined; // sed -i writes in place
		}
		if (cmd === 'git' && !READONLY_GIT_SUBCOMMANDS.has(tokens[1] ?? '')) {
			return undefined;
		}
		// The FIRST segment sets the fold class (a `grep … | head` is a search
		// that happens to be piped, not a file read).
		result ??= cls;
	}
	return result;
}

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
			/** Search invocations (glob + grep + search-class shell), occurrences not deduped. */
			readonly searches: number;
			/** Edit-sweep rollups: total edit/write invocations (`files` then holds the deduped file count). 0 on read rollups. */
			readonly edits: number;
			/** Sum of member durations. */
			readonly durationMs: number;
			/** The trailing member is the run's open call — the rollup carries the spinner. */
			readonly running: boolean;
	  }
	| {
			readonly kind: 'verify';
			/** The aggregated verification steps, original indices preserved for stable React keys. */
			readonly steps: readonly { readonly step: ISessionWorkStep; readonly index: number }[];
			/** Deduped check kinds in first-seen order ("typecheck ✓ · lint ✓"). */
			readonly checks: readonly ('test' | 'typecheck' | 'lint' | 'format')[];
			/** Summed test counts across members whose runner reported them; absent when none did. */
			readonly passed?: number;
			readonly failed?: number;
			/** Sum of member durations. */
			readonly durationMs: number;
	  };

/** update_plan's progress, parsed from its persisted detail ("Plan (5/7 done):\n[x] …\n[~] …"). */
export interface IPlanProgress {
	readonly done: number;
	readonly total: number;
	/** The step in flight (first `[~]`), else the next pending one (first `[ ]`). */
	readonly current?: string;
	/** The full checklist, in order — the expanded row renders these, not the raw text. */
	readonly items: readonly { readonly state: 'done' | 'doing' | 'pending'; readonly text: string }[];
}

/**
 * Plan rows render as PROGRESS, not a text dump (2026-08-05 思考流改版):
 * "Plan 5/7 · <current step>" + a bar on the row, a styled checklist on
 * expand. Parses the update_plan tool's own stable output format
 * (locale-independent, never localized).
 */
export function parsePlanProgress(detail: string | undefined): IPlanProgress | undefined {
	if (detail === undefined) {
		return undefined;
	}
	const head = /^Plan \((\d+)\/(\d+) done\)/m.exec(detail);
	if (head === null) {
		return undefined;
	}
	const items: { state: 'done' | 'doing' | 'pending'; text: string }[] = [];
	for (const match of detail.matchAll(/^\[(x|~| )\] (.+)$/gm)) {
		items.push({ state: match[1] === 'x' ? 'done' : match[1] === '~' ? 'doing' : 'pending', text: match[2]! });
	}
	const doing = items.find(item => item.state === 'doing');
	const pending = items.find(item => item.state === 'pending');
	const current = doing?.text ?? pending?.text;
	return { done: Number(head[1]), total: Number(head[2]), ...(current === undefined ? {} : { current }), items };
}

/**
 * The fold a step joins, if any: a read-class bucket (read tools, plus
 * read-only shell via {@link classifyShellRead}) or the edit sweep. Errors and
 * unclassifiable calls fold nothing — they break the run and stay visible.
 */
function foldClassOf(step: ISessionWorkStep): { readonly kind: 'read' | 'edit'; readonly bucket?: 'file' | 'dir' | 'search' } | undefined {
	if (step.kind !== 'tool' || stepError(step)) {
		return undefined;
	}
	const tool = stepTool(step);
	if (tool === 'edit_file' || tool === 'write_file') {
		return { kind: 'edit' };
	}
	if (tool === 'bash') {
		const arg = stepArg(step);
		const bucket = arg === undefined ? undefined : classifyShellRead(arg);
		return bucket === undefined ? undefined : { kind: 'read', bucket };
	}
	const bucket = READ_CLASS[tool ?? ''];
	return bucket === undefined ? undefined : { kind: 'read', bucket };
}

/**
 * Fold consecutive successful same-kind tool steps (Q2's converged industry
 * rule, revised 2026-08-05): read-class steps fold into "Explored …" rollups
 * (read-only bash included, via {@link classifyShellRead}); consecutive
 * edit_file/write_file sweeps fold into "Edited …" rollups of their OWN kind —
 * the revision is that writes aggregate with writes, never with reads, and an
 * errored or unclassifiable call still breaks the run. A lone member stays a
 * plain row. Thinking BREAKS a run (2a revised 2026-08-05 v2): thought
 * content is now first-class prose rendered at its chronological position —
 * deferring it past a fold would misplace the reasoning after the actions it
 * motivated. Counters are derived from an append-only array, so they are
 * monotonic within a run by construction.
 */
export function buildWorkRenderItems(steps: readonly ISessionWorkStep[]): WorkRenderItem[] {
	const items: WorkRenderItem[] = [];
	let group: { step: ISessionWorkStep; index: number; bucket?: 'file' | 'dir' | 'search' }[] = [];
	let groupKind: 'read' | 'edit' | undefined;

	const flush = (): void => {
		if (group.length === 0) {
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
			let edits = 0;
			let durationMs = 0;
			for (const member of group) {
				durationMs += member.step.durationMs;
				const arg = stepArg(member.step);
				if (groupKind === 'edit') {
					edits += 1;
					if (arg === undefined) {
						files += 1;
					} else if (!seenFiles.has(arg)) {
						seenFiles.add(arg);
						files += 1;
					}
					continue;
				}
				if (member.bucket === 'file') {
					if (arg === undefined) {
						files += 1;
					} else if (!seenFiles.has(arg)) {
						seenFiles.add(arg);
						files += 1;
					}
				} else if (member.bucket === 'dir') {
					if (arg === undefined) {
						dirs += 1;
					} else if (!seenDirs.has(arg)) {
						seenDirs.add(arg);
						dirs += 1;
					}
				} else if (member.bucket === 'search') {
					searches += 1;
				}
			}
			items.push({
				kind: 'rollup',
				steps: group.map(({ step, index }) => ({ step, index })),
				files,
				dirs,
				searches,
				edits,
				durationMs,
				running: group[group.length - 1]!.step.running === true,
			});
		}
		group = [];
		groupKind = undefined;
	};

	for (let index = 0; index < steps.length; index++) {
		const step = steps[index]!;
		const fold = foldClassOf(step);
		if (fold !== undefined) {
			// Parallel children interleave chronologically — a group never spans
			// agents (or mixes a child with the main loop), so each sweep stays
			// attributable even when the fold hides the individual rows. Reads
			// and edits never share a group either (Q2: kinds never mix).
			if (group.length > 0 && (groupKind !== fold.kind || group[group.length - 1]!.step.agent !== step.agent)) {
				flush();
			}
			groupKind = fold.kind;
			group.push(fold.bucket === undefined ? { step, index } : { step, index, bucket: fold.bucket });
		} else {
			flush();
			items.push({ kind: 'step', step, index });
		}
	}
	flush();
	return synthesizeVerifyRow(items);
}

/**
 * Verified 结论行 (2026-08-05): a TRAILING run of successful verification
 * calls (bash steps whose resultMeta.verify the provider persisted) collapses
 * into one conclusion row — "Verified typecheck ✓ · lint ✓ · tests 41/41".
 * Tail-only by design: verification mid-run (test → more edits) is not the
 * run's conclusion and stays ordinary rows; a FAILED verify never joins (its
 * error row is the evidence, Q1); a still-running one waits for its outcome.
 * Pure over persisted facts — replay renders identically (Q3).
 */
function synthesizeVerifyRow(items: readonly WorkRenderItem[]): WorkRenderItem[] {
	const tail: { step: ISessionWorkStep; index: number }[] = [];
	let cut = items.length;
	while (cut > 0) {
		const item = items[cut - 1]!;
		const verify = item.kind === 'step' && item.step.kind === 'tool' && item.step.outcome === 'ok' && item.step.running !== true ? item.step.resultMeta?.verify : undefined;
		if (item.kind !== 'step' || verify === undefined) {
			break;
		}
		tail.unshift({ step: item.step, index: item.index });
		cut--;
	}
	if (tail.length === 0) {
		return items.slice();
	}
	const checks: ('test' | 'typecheck' | 'lint' | 'format')[] = [];
	let passed = 0;
	let failed = 0;
	let anyPassed = false;
	let anyFailed = false;
	let durationMs = 0;
	for (const member of tail) {
		durationMs += member.step.durationMs;
		const verify = member.step.resultMeta!.verify!;
		if (!checks.includes(verify.kind)) {
			checks.push(verify.kind);
		}
		if (verify.passed !== undefined) {
			passed += verify.passed;
			anyPassed = true;
		}
		if (verify.failed !== undefined) {
			failed += verify.failed;
			anyFailed = true;
		}
	}
	return [
		...items.slice(0, cut),
		{
			kind: 'verify',
			steps: tail,
			checks,
			...(anyPassed ? { passed } : {}),
			...(anyFailed ? { failed } : {}),
			durationMs,
		},
	];
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
