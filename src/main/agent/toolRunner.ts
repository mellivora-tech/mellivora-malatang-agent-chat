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
 * SEAM (point 3 — concurrency): every tool runs serially today. To parallelize,
 * partition `toolUses` into runs where `tool.isConcurrencySafe(input)` holds and
 * execute each safe run concurrently (bounded, e.g. 10), keeping non-safe tools
 * serial. Nothing outside this function needs to change.
 */
export async function* executeToolUses(
	toolUses: readonly IToolUseBlock[],
	tools: readonly IAgentTool[],
	permissionGate: IPermissionGate,
	signal: AbortSignal,
	guard?: ILoopGuard,
): AsyncGenerator<IAgentEvent, IToolResultBlock[]> {
	const results: IToolResultBlock[] = [];

	for (const use of toolUses) {
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
	}

	return results;
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
