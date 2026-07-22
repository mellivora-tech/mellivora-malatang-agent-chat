/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentEvent, IAgentTool, IPermissionGate, IToolResultBlock, IToolUseBlock } from './agentTypes.js';
import type { ILoopGuard } from './loopGuard.js';
import { runHooksUntilBlock, type IHook, type IHookResult } from './hooks/hooks.js';

/**
 * Observability (§9): a PreToolUse hook that blocked, FAILED OPEN, or injected
 * context becomes a `hook` event the loop yields (after the tool_result, so
 * tool_use/tool_result order is untouched).
 *
 * fail-open is reported even though it has no effect on the call — that is the
 * whole point. A hook whose command is misspelled, times out, or crashes still
 * returns `allow`, so judging by consequence alone it is invisible; "this hook
 * silently stopped working" is exactly the failure this event exists to expose.
 */
function preToolHookEvents(results: readonly IHookResult[]): IAgentEvent[] {
	const events: IAgentEvent[] = [];
	for (const result of results) {
		if (result.decision === 'block') {
			events.push({ type: 'hook', event: 'PreToolUse', hookId: result.hookId, decision: 'block' });
		} else if (result.failOpen !== undefined) {
			events.push({ type: 'hook', event: 'PreToolUse', hookId: result.hookId, decision: result.decision, failOpen: true });
		} else if (result.additionalContext !== undefined) {
			events.push({ type: 'hook', event: 'PreToolUse', hookId: result.hookId, decision: result.decision, injected: true });
		}
	}
	return events;
}

/**
 * Run the tool_use blocks from one assistant turn, yielding tool_use / tool_result
 * events as it goes and returning the collected result blocks (which the loop
 * appends as a single user message).
 *
 * Concurrency (the former point-3 seam, filled after CC's partitionToolCalls):
 * consecutive calls whose tool says `isConcurrencySafe(input)` run as one
 * concurrent batch; everything else runs serially in order. `isConcurrencySafe`
 * throwing counts as NOT safe — conservative. Result blocks keep the original
 * call order regardless of completion order (the API requires tool_results to
 * match the tool_use sequence). A concurrent batch emits its use/result event
 * pairs once the batch settles — today's safe tools are millisecond-local
 * (fs reads, JS greps), so no live-progress fidelity is lost.
 */
export async function* executeToolUses(
	toolUses: readonly IToolUseBlock[],
	tools: readonly IAgentTool[],
	permissionGate: IPermissionGate,
	signal: AbortSignal,
	guard?: ILoopGuard,
	preToolHooks: readonly IHook[] = [],
): AsyncGenerator<IAgentEvent, IToolResultBlock[]> {
	const results: IToolResultBlock[] = [];

	for (const batch of partitionBySafety(toolUses, tools)) {
		if (batch.length === 1) {
			const use = batch[0]!;
			yield { type: 'tool_use', toolUseId: use.id, name: use.name, input: use.input };

			// The guard sees every call (blocked ones included, so a 4th identical
			// attempt is also blocked). A blocked call skips execution entirely —
			// the error result is the model's feedback, same as any other failure.
			const blocked = guard?.check(use);
			if (blocked) {
				yield { type: 'loop_guard', toolUseId: use.id, name: use.name, repeatCount: blocked.repeatCount };
				const block = errorResult(use.id, blocked.message);
				results.push(block);
				yield { type: 'tool_result', toolUseId: block.toolUseId, content: block.content, isError: block.isError };
				continue;
			}

			const { block, hookEvents } = await runSingleToolUse(use, tools, permissionGate, signal, preToolHooks);
			results.push(block);
			yield { type: 'tool_result', toolUseId: block.toolUseId, content: block.content, isError: block.isError };
			for (const hookEvent of hookEvents) {
				yield hookEvent;
			}
			continue;
		}

		// Concurrent batch: guard-check synchronously in call order (the repeat
		// counter must see every call), then emit ALL tool_use events up front —
		// a batch member that runs for minutes (a parallel spawn_agent sweep)
		// must be visible as an open call from the moment it starts, not after
		// the whole batch settles. Execution runs under a concurrency cap;
		// results are emitted in call order regardless of completion order (the
		// API pairs them by tool_use_id, the transcript stays deterministic).
		const checked = batch.map(use => ({ use, blocked: guard?.check(use) }));
		for (const { use, blocked } of checked) {
			yield { type: 'tool_use', toolUseId: use.id, name: use.name, input: use.input };
			if (blocked) {
				yield { type: 'loop_guard', toolUseId: use.id, name: use.name, repeatCount: blocked.repeatCount };
			}
		}
		const running = startWithLimit(checked, maxToolConcurrency(), async ({ use, blocked }) => {
			const startedAt = Date.now();
			const outcome = blocked
				? { block: errorResult(use.id, blocked.message), hookEvents: [] as readonly IAgentEvent[] }
				: await runSingleToolUse(use, tools, permissionGate, signal, preToolHooks);
			return { ...outcome, durationMs: Date.now() - startedAt };
		});
		// Stream results in call order as they settle — the first call's result
		// goes out the moment it (and nothing else) is done, instead of the whole
		// batch's results arriving together at the end. Each event carries the
		// call's OWN measured duration: ordered emission means a fast later call
		// waits on slower earlier ones, so arrival time is not its runtime (four
		// parallel spawns all read as the slowest one otherwise — seen live).
		for (const promise of running) {
			const { block, durationMs, hookEvents } = await promise;
			results.push(block);
			yield { type: 'tool_result', toolUseId: block.toolUseId, content: block.content, isError: block.isError, durationMs };
			for (const hookEvent of hookEvents) {
				yield hookEvent;
			}
		}
	}

	return results;
}

/**
 * Concurrency cap for one batch. 4 by default: a k3 probe (2026-07-18, 5
 * concurrent minimal requests) saw zero 429s at 5 streams, so 4 leaves
 * headroom for the main loop's own next request; parallel sub-agents are the
 * only tools that hold a slot for minutes.
 */
export function maxToolConcurrency(): number {
	const parsed = Number(process.env['MELLIVORA_TOOL_CONCURRENCY']);
	return Number.isInteger(parsed) && parsed >= 1 ? parsed : 4;
}

/** Start every item under a slot limit and return the per-item promises immediately (input order) — callers await them in order to stream ordered results. */
function startWithLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R>[] {
	let active = 0;
	const waiters: (() => void)[] = [];
	const acquire = (): Promise<void> =>
		new Promise(resolve => {
			if (active < limit) {
				active += 1;
				resolve();
			} else {
				waiters.push(() => {
					active += 1;
					resolve();
				});
			}
		});
	const release = (): void => {
		active -= 1;
		waiters.shift()?.();
	};
	return items.map(async item => {
		await acquire();
		try {
			return await run(item);
		} finally {
			release();
		}
	});
}

/** Split one turn's calls into maximal runs of concurrency-safe tools; unsafe (or unknown) tools become singleton batches. */
function partitionBySafety(toolUses: readonly IToolUseBlock[], tools: readonly IAgentTool[]): IToolUseBlock[][] {
	const batches: IToolUseBlock[][] = [];
	let run: IToolUseBlock[] = [];
	const flush = (): void => {
		if (run.length > 0) {
			batches.push(run);
			run = [];
		}
	};
	for (const use of toolUses) {
		const tool = tools.find(candidate => candidate.name === use.name);
		let safe: boolean;
		try {
			safe = tool !== undefined && tool.isConcurrencySafe(use.input);
		} catch {
			safe = false;
		}
		if (safe) {
			run.push(use);
		} else {
			flush();
			batches.push([use]);
		}
	}
	flush();
	return batches;
}

/**
 * The permission gate for a single call. Every failure path — unknown tool,
 * bad input, denied permission, thrown tool — becomes an error tool_result fed
 * back to the model. It never throws and never halts the loop.
 */
interface ISingleToolOutcome {
	readonly block: IToolResultBlock;
	/** PreToolUse hook events this call produced (empty when no hook fired) — the caller yields them after the tool_result. */
	readonly hookEvents: readonly IAgentEvent[];
}

async function runSingleToolUse(
	use: IToolUseBlock,
	tools: readonly IAgentTool[],
	permissionGate: IPermissionGate,
	signal: AbortSignal,
	preToolHooks: readonly IHook[],
): Promise<ISingleToolOutcome> {
	const tool = tools.find(candidate => candidate.name === use.name);
	if (!tool) {
		return { block: errorResult(use.id, `No such tool available: ${use.name}`), hookEvents: [] };
	}

	const validation = tool.validateInput(use.input);
	if (!validation.ok) {
		return { block: errorResult(use.id, `InputValidationError: ${validation.error}`), hookEvents: [] };
	}

	// PreToolUse hooks (design docs/design/hooks): discipline checks after input
	// validation, before permission + execution. block → the call becomes an
	// error result fed back to the model; modify → the chained input flows on;
	// allow + additionalContext → the reminder rides the tool result so the
	// model sees it alongside the output (the inject-not-block posture, Q1).
	// Permissions and the loop guard stay native — tool-coupled / concurrency-
	// synchronous, they are not routed through the generic registry.
	const matching = preToolHooks.filter(hook => hook.toolMatcher === undefined || hook.toolMatcher.test(use.name));
	const pre = await runHooksUntilBlock(matching, { event: 'PreToolUse', toolName: use.name, toolInput: validation.value });
	const hookEvents = preToolHookEvents(pre.results);
	if (pre.decision === 'block' && pre.reason !== undefined) {
		return { block: errorResult(use.id, pre.reason), hookEvents };
	}
	const hookedInput = pre.decision === 'modify' && 'modifiedInput' in pre ? pre.modifiedInput : validation.value;

	let decision;
	try {
		decision = await permissionGate.check(tool, hookedInput, { toolUseId: use.id });
	} catch (error) {
		return { block: errorResult(use.id, `Permission check failed: ${describeError(error)}`), hookEvents };
	}

	if (decision.behavior !== 'allow') {
		return { block: errorResult(use.id, decision.message), hookEvents };
	}

	const input = decision.updatedInput !== undefined ? decision.updatedInput : hookedInput;

	try {
		const result = await tool.call(input, { toolUseId: use.id, signal });
		const isError = result.isError ?? false;
		// A successful result carries any PreToolUse-injected reminder appended.
		const content = pre.additionalContext !== undefined && !isError ? `${result.content}\n\n${pre.additionalContext}` : result.content;
		return { block: { type: 'tool_result', toolUseId: use.id, content, isError }, hookEvents };
	} catch (error) {
		return { block: errorResult(use.id, `Tool ${tool.name} threw: ${describeError(error)}`), hookEvents };
	}
}

function errorResult(toolUseId: string, content: string): IToolResultBlock {
	return { type: 'tool_result', toolUseId, content, isError: true };
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
