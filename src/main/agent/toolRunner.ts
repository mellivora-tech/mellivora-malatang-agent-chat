/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentEvent, IAgentTool, IPermissionGate, IToolResultBlock, IToolUseBlock } from './agentTypes.js';
import type { ILoopGuard } from './loopGuard.js';

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

			const block = await runSingleToolUse(use, tools, permissionGate, signal);
			results.push(block);
			yield { type: 'tool_result', toolUseId: block.toolUseId, content: block.content, isError: block.isError };
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
			const block = blocked ? errorResult(use.id, blocked.message) : await runSingleToolUse(use, tools, permissionGate, signal);
			return { block, durationMs: Date.now() - startedAt };
		});
		// Stream results in call order as they settle — the first call's result
		// goes out the moment it (and nothing else) is done, instead of the whole
		// batch's results arriving together at the end. Each event carries the
		// call's OWN measured duration: ordered emission means a fast later call
		// waits on slower earlier ones, so arrival time is not its runtime (four
		// parallel spawns all read as the slowest one otherwise — seen live).
		for (const promise of running) {
			const { block, durationMs } = await promise;
			results.push(block);
			yield { type: 'tool_result', toolUseId: block.toolUseId, content: block.content, isError: block.isError, durationMs };
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
async function runSingleToolUse(use: IToolUseBlock, tools: readonly IAgentTool[], permissionGate: IPermissionGate, signal: AbortSignal): Promise<IToolResultBlock> {
	const tool = tools.find(candidate => candidate.name === use.name);
	if (!tool) {
		return errorResult(use.id, `No such tool available: ${use.name}`);
	}

	const validation = tool.validateInput(use.input);
	if (!validation.ok) {
		return errorResult(use.id, `InputValidationError: ${validation.error}`);
	}

	let decision;
	try {
		decision = await permissionGate.check(tool, validation.value, { toolUseId: use.id });
	} catch (error) {
		return errorResult(use.id, `Permission check failed: ${describeError(error)}`);
	}

	if (decision.behavior !== 'allow') {
		return errorResult(use.id, decision.message);
	}

	const input = decision.updatedInput !== undefined ? decision.updatedInput : validation.value;

	try {
		const result = await tool.call(input, { toolUseId: use.id, signal });
		return { type: 'tool_result', toolUseId: use.id, content: result.content, isError: result.isError ?? false };
	} catch (error) {
		return errorResult(use.id, `Tool ${tool.name} threw: ${describeError(error)}`);
	}
}

function errorResult(toolUseId: string, content: string): IToolResultBlock {
	return { type: 'tool_result', toolUseId, content, isError: true };
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
