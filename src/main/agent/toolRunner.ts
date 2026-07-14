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

		// Concurrent batch: guard-check up front (synchronous — the repeat counter
		// must see calls in order), start the survivors together, then emit
		// ordered use/result pairs.
		const settled = await Promise.all(
			batch.map(use => {
				const blocked = guard?.check(use);
				if (blocked) {
					return Promise.resolve({ use, blocked, block: errorResult(use.id, blocked.message) });
				}
				return runSingleToolUse(use, tools, permissionGate, signal).then(block => ({ use, blocked: undefined, block }));
			}),
		);
		for (const { use, blocked, block } of settled) {
			yield { type: 'tool_use', toolUseId: use.id, name: use.name, input: use.input };
			if (blocked) {
				yield { type: 'loop_guard', toolUseId: use.id, name: use.name, repeatCount: blocked.repeatCount };
			}
			results.push(block);
			yield { type: 'tool_result', toolUseId: block.toolUseId, content: block.content, isError: block.isError };
		}
	}

	return results;
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
		let safe = false;
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
