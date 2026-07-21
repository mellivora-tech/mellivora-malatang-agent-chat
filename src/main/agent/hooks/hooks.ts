/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The agent hook subsystem (design docs/design/hooks/hook-subsystem-design.md).
 * A lifecycle interception platform: at fixed events the loop fires the
 * registered hooks, each of which may BLOCK, inject CONTEXT, MODIFY a tool's
 * input, or just observe — all deterministically, without a model call. It is
 * NOT a strategy layer: hooks run registered checks when an event fires; they
 * never classify task difficulty or route models.
 *
 * M1 (this module): the contract, registry and dispatcher. The dispatcher's
 * composition rules are the whole subject of this file's tests. Wiring the fire
 * points into agentLoop and migrating the existing hardcoded interceptions
 * (permissionGate / loopGuard / replyVerifier / the system-reminder family)
 * lands incrementally on top of this core.
 */

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'PreCompact', 'SessionStart', 'SessionEnd'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** What a hook receives. Fields are event-specific; a hook reads only what its event carries. */
export interface IHookInput {
	readonly event: HookEvent;
	readonly sessionId?: string;
	readonly projectId?: string;
	readonly turn?: number;
	/** PreToolUse / PostToolUse. */
	readonly toolName?: string;
	/** PreToolUse — the (possibly already chained-modified) tool input. */
	readonly toolInput?: unknown;
	/** PostToolUse. */
	readonly toolResult?: unknown;
	/** UserPromptSubmit / Stop — the user's message. */
	readonly question?: string;
	/** Stop — the assistant's final reply under review. */
	readonly answer?: string;
	/** A short digest of run progress (never the full context). */
	readonly contextDigest?: string;
}

/** A single hook's verdict. */
export interface IHookDecision {
	readonly decision: 'allow' | 'block' | 'modify';
	/** block: fed back to the model (approval refusal / verifier retry feedback). */
	readonly reason?: string;
	/** Injected into context (the system-reminder pattern). Accumulates across hooks even under a block. */
	readonly additionalContext?: string;
	/** modify: the rewritten tool input, chained into the next hook. */
	readonly modifiedInput?: unknown;
	/** Optional label surfaced to observability (e.g. the reply-verifier verdict). */
	readonly note?: string;
	/** Opaque hook-specific payload the loop reads to emit that hook's own observability event (e.g. the reply-verifier verdict + reason). */
	readonly data?: unknown;
}

/** One hook's outcome, preserved per-hook so the loop can emit each hook's own event. */
export interface IHookResult {
	readonly hookId: string;
	readonly decision: 'allow' | 'block' | 'modify';
	readonly note?: string;
	readonly data?: unknown;
}

export interface IHook {
	readonly id: string;
	readonly event: HookEvent;
	/** PreToolUse / PostToolUse only: restrict to matching tool names. Absent → all tools. */
	readonly toolMatcher?: RegExp;
	run(input: IHookInput): Promise<IHookDecision> | IHookDecision;
}

/** The composed result of firing every hook for one event. */
export interface IHookOutcome {
	readonly decision: 'allow' | 'block' | 'modify';
	/** Aggregated block reasons (one per blocking hook), newline-joined. */
	readonly reason?: string;
	/** Accumulated injected context, newline-joined. */
	readonly additionalContext?: string;
	/** Final chained tool input (only when at least one hook modified it). */
	readonly modifiedInput?: unknown;
	/** ids of the hooks that blocked — for observability. */
	readonly blockedBy?: readonly string[];
	/** Per-hook results in dispatch order — the loop reads these to emit each hook's own observability event. */
	readonly results: readonly IHookResult[];
}

/**
 * Static registry: internal hooks register first so they run before user hooks
 * (internal hooks are the safety/correctness floor). Registration order is
 * dispatch order within an event.
 */
export class HookRegistry {
	private readonly hooks: IHook[] = [];

	register(hook: IHook): void {
		this.hooks.push(hook);
	}

	/** Hooks for an event, in registration order, filtered by the tool matcher when a tool name is given. */
	forEvent(event: HookEvent, toolName?: string): readonly IHook[] {
		return this.hooks.filter(hook => hook.event === event && (hook.toolMatcher === undefined || toolName === undefined || hook.toolMatcher.test(toolName)));
	}
}

/**
 * Fire an event's hooks and compose their decisions.
 *
 * Composition (design §4):
 *  - any BLOCK wins → the outcome is block; every blocking hook's reason is aggregated.
 *  - additionalContext ACCUMULATES across all hooks, even under a block.
 *  - MODIFY chains: each hook sees the previous hook's modifiedInput.
 *  - fail-open: a hook that throws is skipped, never crashing the loop.
 */
export async function runHooks(hooks: readonly IHook[], input: IHookInput): Promise<IHookOutcome> {
	const reasons: string[] = [];
	const contexts: string[] = [];
	const blockedBy: string[] = [];
	const results: IHookResult[] = [];
	let currentInput = input.toolInput;
	let modified = false;

	for (const hook of hooks) {
		let decision: IHookDecision;
		try {
			decision = await hook.run({ ...input, toolInput: currentInput });
		} catch {
			continue; // fail-open — a broken hook must never harm the run.
		}
		results.push({
			hookId: hook.id,
			decision: decision.decision,
			...(decision.note !== undefined ? { note: decision.note } : {}),
			...(decision.data !== undefined ? { data: decision.data } : {}),
		});
		if (decision.additionalContext) {
			contexts.push(decision.additionalContext);
		}
		if (decision.decision === 'block') {
			blockedBy.push(hook.id);
			if (decision.reason) {
				reasons.push(decision.reason);
			}
		} else if (decision.decision === 'modify' && 'modifiedInput' in decision) {
			currentInput = decision.modifiedInput;
			modified = true;
		}
	}

	const context = contexts.length > 0 ? contexts.join('\n') : undefined;

	if (blockedBy.length > 0) {
		return {
			decision: 'block',
			blockedBy,
			results,
			...(reasons.length > 0 ? { reason: reasons.join('\n') } : {}),
			...(context !== undefined ? { additionalContext: context } : {}),
		};
	}
	return {
		decision: modified ? 'modify' : 'allow',
		results,
		...(context !== undefined ? { additionalContext: context } : {}),
		...(modified ? { modifiedInput: currentInput } : {}),
	};
}

/**
 * First-block-wins dispatch: run hooks in order and STOP at the first block,
 * returning its reason. This is the Stop/PreToolUse semantics — the loop's
 * hardcoded nudges fired at most one per completed turn (first match, then
 * retry), and PreToolUse denies on the first refusal. `results` holds every
 * hook evaluated up to and including the blocker, so the loop can emit the
 * observability event of each hook that actually ran. fail-open on throw.
 */
export async function runHooksUntilBlock(hooks: readonly IHook[], input: IHookInput): Promise<IHookOutcome> {
	const contexts: string[] = [];
	const results: IHookResult[] = [];
	let currentInput = input.toolInput;
	let modified = false;

	for (const hook of hooks) {
		let decision: IHookDecision;
		try {
			decision = await hook.run({ ...input, toolInput: currentInput });
		} catch {
			continue; // fail-open.
		}
		results.push({
			hookId: hook.id,
			decision: decision.decision,
			...(decision.note !== undefined ? { note: decision.note } : {}),
			...(decision.data !== undefined ? { data: decision.data } : {}),
		});
		if (decision.additionalContext) {
			contexts.push(decision.additionalContext);
		}
		if (decision.decision === 'block') {
			const context = contexts.length > 0 ? contexts.join('\n') : undefined;
			return {
				decision: 'block',
				blockedBy: [hook.id],
				results,
				...(decision.reason !== undefined ? { reason: decision.reason } : {}),
				...(context !== undefined ? { additionalContext: context } : {}),
			};
		}
		if (decision.decision === 'modify' && 'modifiedInput' in decision) {
			currentInput = decision.modifiedInput;
			modified = true;
		}
	}

	const context = contexts.length > 0 ? contexts.join('\n') : undefined;
	return {
		decision: modified ? 'modify' : 'allow',
		results,
		...(context !== undefined ? { additionalContext: context } : {}),
		...(modified ? { modifiedInput: currentInput } : {}),
	};
}
