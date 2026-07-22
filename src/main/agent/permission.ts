/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentTool, IPermissionContext, IPermissionGate } from './agentTypes.js';
import { isSandboxEscape } from './approvalAllowlist.js';

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

/** The user's answer to an approval prompt. `reason` (deny only) is the user's
 *  "do this instead" — it rides the deny message so the model can change course
 *  instead of retrying the same call. */
export interface IApprovalDecision {
	readonly approved: boolean;
	readonly reason?: string;
}

export type ApprovalHandler = (tool: IAgentTool, input: unknown, context: IPermissionContext) => Promise<IApprovalDecision>;

function denyMessage(base: string, reason: string | undefined): string {
	return reason === undefined || reason.trim() === '' ? base : `${base} Instead, the user says: ${reason.trim()}`;
}

/** Build the permission gate for a session's mode. */
export function createGateForMode(mode: PermissionMode, requestApproval: ApprovalHandler): IPermissionGate {
	switch (mode) {
		case 'full':
			// Full mode runs everything unattended EXCEPT a sandbox escape: there
			// the seatbelt is the LAST guard, so removing it always asks — the
			// session allowlist ("mvn *（沙箱外）") is the opt-out, not the mode.
			return {
				async check(tool, input, context) {
					if (!isSandboxEscape(tool.name, input)) {
						return { behavior: 'allow' };
					}
					const decision = await requestApproval(tool, input, context);
					return decision.approved ? { behavior: 'allow' } : { behavior: 'deny', message: denyMessage(`The user declined running ${tool.name} outside the sandbox.`, decision.reason) };
				},
			};
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
					const decision = await requestApproval(tool, input, context);
					return decision.approved ? { behavior: 'allow' } : { behavior: 'deny', message: denyMessage(`The user declined ${tool.name}.`, decision.reason) };
				},
			};
		case 'ask':
		default:
			return {
				async check(tool, input, context) {
					if (tool.isReadOnly(input)) {
						return { behavior: 'allow' };
					}
					const decision = await requestApproval(tool, input, context);
					return decision.approved ? { behavior: 'allow' } : { behavior: 'deny', message: denyMessage(`The user declined ${tool.name}.`, decision.reason) };
				},
			};
	}
}

/** One-line human summary of a tool call, shown in the approval prompt. */
export function describeToolCall(toolName: string, input: unknown): string {
	const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
	switch (toolName) {
		case 'bash':
			return `${isSandboxEscape(toolName, input) ? '[沙箱外] ' : ''}${typeof record.command === 'string' ? record.command : 'run a command'}`;
		case 'write_file':
			return typeof record.path === 'string' ? `write ${record.path}` : 'write a file';
		case 'upload_to_server':
			return typeof record.local_path === 'string' && typeof record.remote_path === 'string'
				? `上传 ${record.local_path} → ${typeof record.server === 'string' ? `${record.server}:` : ''}${record.remote_path}`
				: 'upload a file to a server';
		case 'edit_file':
			return typeof record.path === 'string' ? `edit ${record.path}` : 'edit a file';
		case 'execute_data_source':
			// No prefix: the approval card's own localized title says "执行写库";
			// this line is the exact statement being approved.
			return typeof record.source === 'string' && typeof record.sql === 'string' ? `${record.source}: ${record.sql}` : 'execute a database write';
		default:
			return toolName;
	}
}
