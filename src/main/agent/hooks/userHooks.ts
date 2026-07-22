/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { HOOK_EVENTS, type HookEvent, type IHook, type IHookDecision, type IHookInput } from './hooks.js';

/**
 * User-configurable hooks (design docs/design/hooks §6/§10 M3): a hook declared
 * in config that runs an EXTERNAL COMMAND at a lifecycle event. The command
 * receives the hook input as JSON on stdin and returns its decision on stdout.
 *
 * This module is the EXECUTION MECHANISM and its contract only — parse + adapt +
 * run a command. It deliberately does NOT decide WHICH configs become live
 * hooks: that is the trust model's job (§8 — global configs trusted, project
 * configs approved-per-change), which gates loading. Nothing here spawns a
 * command until a trusted loader constructs a hook from a config, so this module
 * carries no attack surface on its own.
 *
 * Fail-open is absolute: a command that times out, fails to spawn, exits with an
 * unexpected code, or prints garbage must NEVER harm the run — it resolves to
 * `allow`. A hook can only BLOCK by exiting 2 or printing an explicit
 * `{"decision":"block"}`.
 */

export interface IUserHookConfig {
	/** Stable id (from config, else derived from event + position). */
	readonly id: string;
	readonly event: HookEvent;
	/** A shell command line; receives the hook input JSON on stdin. */
	readonly command: string;
	/** PreToolUse / PostToolUse: a regex source restricting which tools fire it. */
	readonly toolMatcher?: string;
	readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
/** A command that exits with this code blocks the action (CC's simple-script convention). */
const BLOCK_EXIT_CODE = 2;

function isValidRegex(source: string): boolean {
	try {
		void new RegExp(source);
		return true;
	} catch {
		return false;
	}
}

/** Validate one raw config entry into an IUserHookConfig, or undefined if malformed (never throws). */
export function parseUserHookConfig(raw: unknown, index: number): IUserHookConfig | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	const event = record['event'];
	if (typeof event !== 'string' || !(HOOK_EVENTS as readonly string[]).includes(event)) {
		return undefined;
	}
	const command = record['command'];
	if (typeof command !== 'string' || command.trim() === '') {
		return undefined;
	}
	const matcher = record['toolMatcher'];
	if (matcher !== undefined && (typeof matcher !== 'string' || !isValidRegex(matcher))) {
		return undefined;
	}
	const timeout = record['timeoutMs'];
	if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)) {
		return undefined;
	}
	const id = typeof record['id'] === 'string' && record['id'].length > 0 ? record['id'] : `user:${event}:${index}`;
	return {
		id,
		event: event as HookEvent,
		command,
		...(typeof matcher === 'string' ? { toolMatcher: matcher } : {}),
		...(typeof timeout === 'number' ? { timeoutMs: timeout } : {}),
	};
}

/** Adapt a validated config into a runnable hook. The command is spawned per fire. */
export function createCommandHook(config: IUserHookConfig): IHook {
	const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return {
		id: config.id,
		event: config.event,
		...(config.toolMatcher !== undefined ? { toolMatcher: new RegExp(config.toolMatcher) } : {}),
		run: (input: IHookInput) => runCommand(config.command, input, timeoutMs),
	};
}

function runCommand(command: string, input: IHookInput, timeoutMs: number): Promise<IHookDecision> {
	return new Promise<IHookDecision>(resolve => {
		let settled = false;
		const finish = (decision: IHookDecision): void => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(decision);
			}
		};

		let child;
		try {
			child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
		} catch (error) {
			resolve({ decision: 'allow', failOpen: `hook command could not be spawned: ${describeSpawnError(error)}` }); // fail-open, but recorded.
			return;
		}

		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				// already gone.
			}
			finish({ decision: 'allow', failOpen: `hook command exceeded its ${timeoutMs}ms timeout` }); // fail-open, but recorded.
		}, timeoutMs);

		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', chunk => (stdout += String(chunk)));
		child.stderr?.on('data', chunk => (stderr += String(chunk)));
		child.on('error', error => finish({ decision: 'allow', failOpen: `hook command failed to launch: ${describeSpawnError(error)}` })); // fail-open, but recorded.
		child.on('close', code => finish(interpret(code, stdout, stderr)));

		try {
			child.stdin?.write(JSON.stringify(input));
			child.stdin?.end();
		} catch {
			// the command may not read stdin; ignore write failures.
		}
	});
}

/** Describe a spawn/launch failure for the fail-open record. */
function describeSpawnError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Map a finished command to a decision. block only on exit 2 or explicit JSON; everything else is allow. */
function interpret(code: number | null, stdout: string, stderr: string): IHookDecision {
	if (code === BLOCK_EXIT_CODE) {
		return { decision: 'block', reason: stdout.trim() || stderr.trim() || 'blocked by a user hook' };
	}
	if (code === 0) {
		const trimmed = stdout.trim();
		if (trimmed === '') {
			return { decision: 'allow' };
		}
		return parseDecision(trimmed) ?? { decision: 'allow', additionalContext: trimmed };
	}
	// A non-zero, non-block exit means the script itself broke (bad path, syntax
	// error). Allowing is right; silently allowing is not — that is exactly how a
	// misconfigured hook masquerades as a working one.
	return { decision: 'allow', failOpen: `hook command exited ${String(code)}${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ''}` };
}

/** Parse structured stdout `{decision, reason?, additionalContext?, modifiedInput?}`; undefined if not that shape. */
function parseDecision(text: string): IHookDecision | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const decision = record['decision'];
	if (decision !== undefined && decision !== 'allow' && decision !== 'block' && decision !== 'modify') {
		return undefined;
	}
	return {
		decision: (decision as 'allow' | 'block' | 'modify' | undefined) ?? 'allow',
		...(typeof record['reason'] === 'string' ? { reason: record['reason'] } : {}),
		...(typeof record['additionalContext'] === 'string' ? { additionalContext: record['additionalContext'] } : {}),
		...('modifiedInput' in record ? { modifiedInput: record['modifiedInput'] } : {}),
	};
}
