/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentTool, IInputValidation, IPermissionContext, IPermissionGate, IToolCallContext, IToolCallResult, IToolSpec } from './agentTypes.js';

export interface IToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
	validateInput(input: unknown): IInputValidation;
	call(input: unknown, context: IToolCallContext): Promise<IToolCallResult>;
	/** Optional; omitting it means "not read-only" (fail-closed). */
	isReadOnly?(input: unknown): boolean;
	/** Optional; omitting it means "not parallel-safe" (fail-closed). */
	isConcurrencySafe?(input: unknown): boolean;
}

/**
 * Build a tool with fail-closed defaults: unless a tool explicitly declares
 * itself read-only / concurrency-safe, it is treated as neither. This mirrors
 * Claude Code's `TOOL_DEFAULTS` — the safe default is the restrictive one.
 */
export function defineTool(definition: IToolDefinition): IAgentTool {
	return {
		name: definition.name,
		description: definition.description,
		inputSchema: definition.inputSchema,
		validateInput: input => definition.validateInput(input),
		call: (input, context) => definition.call(input, context),
		isReadOnly: input => definition.isReadOnly?.(input) ?? false,
		isConcurrencySafe: input => definition.isConcurrencySafe?.(input) ?? false,
	};
}

/** Project a tool onto the schema handed to the model. */
export function toolSpec(tool: IAgentTool): IToolSpec {
	return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

/** Grants every tool. Wire this to the "Full access" composer state. */
export const allowAllPermissionGate: IPermissionGate = {
	async check() {
		return { behavior: 'allow' };
	},
};

/**
 * Read-only tools run automatically; anything that can mutate is routed to
 * `requestApproval` (the future home of the composer's approval UI). Wire the
 * "Full access ⌄" toggle to swap between this and {@link allowAllPermissionGate}.
 */
export function createApprovalPermissionGate(requestApproval: (tool: IAgentTool, input: unknown, context: IPermissionContext) => Promise<boolean>): IPermissionGate {
	return {
		async check(tool, input, context) {
			if (tool.isReadOnly(input)) {
				return { behavior: 'allow' };
			}

			const approved = await requestApproval(tool, input, context);
			return approved ? { behavior: 'allow' } : { behavior: 'deny', message: `Permission denied for ${tool.name}.` };
		},
	};
}
