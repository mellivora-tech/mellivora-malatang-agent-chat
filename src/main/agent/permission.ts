/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { allowAllPermissionGate } from './agentTools.js';
import type { IAgentTool, IPermissionContext, IPermissionGate } from './agentTypes.js';

/**
 * The composer's permission modes. Fail-closed ordering: anything unknown is
 * treated as 'ask'.
 *
 * - ask:       read-only tools run; every mutation asks the user first.
 * - auto-edit: file edits (write_file / edit_file) run unattended; bash still asks.
 * - plan:      read-only exploration only — mutating tools are not offered at all.
 * - full:      everything runs without confirmation.
 */
export type PermissionMode = 'ask' | 'auto-edit' | 'plan' | 'full';

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'ask';

export function asPermissionMode(value: unknown): PermissionMode {
	return value === 'full' || value === 'plan' || value === 'auto-edit' || value === 'ask' ? value : DEFAULT_PERMISSION_MODE;
}

/** File-editing tools 'auto-edit' runs unattended; bash is deliberately excluded. */
const AUTO_EDIT_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file']);

export type ApprovalHandler = (tool: IAgentTool, input: unknown, context: IPermissionContext) => Promise<boolean>;

/** Build the permission gate for a session's mode. */
export function createGateForMode(mode: PermissionMode, requestApproval: ApprovalHandler): IPermissionGate {
	switch (mode) {
		case 'full':
			return allowAllPermissionGate;
		case 'plan':
			return {
				async check(tool, input) {
					return tool.isReadOnly(input) ? { behavior: 'allow' } : { behavior: 'deny', message: `Plan mode is read-only; ${tool.name} is not available. Present a plan instead.` };
				},
			};
		case 'auto-edit':
			return {
				async check(tool, input, context) {
					if (tool.isReadOnly(input) || AUTO_EDIT_TOOLS.has(tool.name)) {
						return { behavior: 'allow' };
					}
					const approved = await requestApproval(tool, input, context);
					return approved ? { behavior: 'allow' } : { behavior: 'deny', message: `The user declined ${tool.name}.` };
				},
			};
		case 'ask':
		default:
			return {
				async check(tool, input, context) {
					if (tool.isReadOnly(input)) {
						return { behavior: 'allow' };
					}
					const approved = await requestApproval(tool, input, context);
					return approved ? { behavior: 'allow' } : { behavior: 'deny', message: `The user declined ${tool.name}.` };
				},
			};
	}
}

/** One-line human summary of a tool call, shown in the approval prompt. */
export function describeToolCall(toolName: string, input: unknown): string {
	const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
	switch (toolName) {
		case 'bash':
			return typeof record.command === 'string' ? record.command : 'run a command';
		case 'write_file':
			return typeof record.path === 'string' ? `write ${record.path}` : 'write a file';
		case 'edit_file':
			return typeof record.path === 'string' ? `edit ${record.path}` : 'edit a file';
		default:
			return toolName;
	}
}
