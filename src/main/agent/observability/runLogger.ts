/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentEvent, IAgentTerminal } from '../agentTypes.js';
import { agentLog } from './agentLog.js';

export interface IRunLoggerContext {
	readonly runId: string;
	readonly sessionId: string;
	readonly model: string;
	readonly mode: string;
	readonly hasWorkspace: boolean;
	readonly toolCount: number;
	readonly cwd?: string;
	readonly projectId?: string;
	/** Project instructions injected into the system prompt (AGENTS.md/CLAUDE.md), when present. */
	readonly instructions?: { readonly file: string; readonly chars: number; readonly truncated: boolean };
	/** Model context window in tokens; absent means auto-compaction is disabled for the run. */
	readonly contextWindow?: number;
}

export interface IRunLogger {
	/** Map one loop event to a structured log event (with real timings). */
	record(event: IAgentEvent): void;
	end(terminal: IAgentTerminal): void;
	error(where: 'model' | 'tool' | 'run', message: string): void;
}

/**
 * Translates the agent loop's {@link IAgentEvent} stream into structured
 * {@link AgentLogEvent}s on the shared bus, tracking per-turn time-to-first-token
 * and per-tool durations. Extracted from the IPC handler so the mapping is
 * unit-testable without a live model.
 */
export function createRunLogger(context: IRunLoggerContext): IRunLogger {
	const base = { runId: context.runId, sessionId: context.sessionId };
	const runStart = Date.now();
	const toolStarts = new Map<string, { readonly name: string; readonly at: number }>();
	let turn = 0;
	let turnStart = runStart;
	let awaitingFirstToken = false;
	let stretch: { kind: 'thinking' | 'text'; turn: number; startedAt: number; text: string } | undefined;
	const now = (): string => new Date().toISOString();

	// Ground truth for whether the model kept reasoning after it had already
	// started its visible answer — independent of the renderer's own step
	// bookkeeping, which can only close a 'thinking' step once per turn.
	const flushStretch = (): void => {
		if (!stretch) {
			return;
		}
		agentLog.emit({
			ts: now(),
			...base,
			type: 'reasoning_stretch',
			turn: stretch.turn,
			kind: stretch.kind,
			durationMs: Date.now() - stretch.startedAt,
			chars: stretch.text.length,
			...(stretch.text.trim() === '' ? {} : { detail: { text: stretch.text } }),
		});
		stretch = undefined;
	};

	const appendStretch = (kind: 'thinking' | 'text', text: string): void => {
		if (stretch?.kind !== kind) {
			flushStretch();
			stretch = { kind, turn, startedAt: Date.now(), text: '' };
		}
		stretch.text += text;
	};

	agentLog.emit({
		ts: now(),
		...base,
		type: 'run_start',
		model: context.model,
		mode: context.mode,
		hasWorkspace: context.hasWorkspace,
		toolCount: context.toolCount,
		...(context.contextWindow !== undefined ? { contextWindow: context.contextWindow } : {}),
		...(context.cwd
			? {
					detail: {
						cwd: context.cwd,
						...(context.projectId ? { projectId: context.projectId } : {}),
						...(context.instructions ? { instructions: context.instructions } : {}),
					},
				}
			: {}),
	});

	const markFirstToken = (): void => {
		if (awaitingFirstToken) {
			awaitingFirstToken = false;
			agentLog.emit({ ts: now(), ...base, type: 'ttft', turn, ttftMs: Date.now() - turnStart });
		}
	};

	return {
		record(event) {
			switch (event.type) {
				case 'turn_start':
					flushStretch();
					turn = event.turn;
					turnStart = Date.now();
					awaitingFirstToken = true;
					agentLog.emit({ ts: now(), ...base, type: 'turn_start', turn });
					break;
				case 'assistant_delta':
					markFirstToken();
					appendStretch('text', event.text);
					break;
				case 'thinking_delta':
					markFirstToken();
					appendStretch('thinking', event.text);
					break;
				case 'tool_use':
					markFirstToken();
					flushStretch();
					toolStarts.set(event.toolUseId, { name: event.name, at: Date.now() });
					agentLog.emit({ ts: now(), ...base, type: 'tool_use', toolUseId: event.toolUseId, name: event.name, detail: { input: event.input } });
					break;
				case 'tool_result': {
					const started = toolStarts.get(event.toolUseId);
					toolStarts.delete(event.toolUseId);
					agentLog.emit({
						ts: now(),
						...base,
						type: 'tool_result',
						toolUseId: event.toolUseId,
						name: started?.name ?? 'unknown',
						ok: !event.isError,
						durationMs: started ? Date.now() - started.at : 0,
						outputBytes: event.content.length,
						detail: { output: event.content },
					});
					break;
				}
				case 'loop_guard':
					agentLog.emit({ ts: now(), ...base, type: 'loop_guard', toolUseId: event.toolUseId, name: event.name, repeatCount: event.repeatCount });
					break;
				case 'reply_verifier':
					agentLog.emit({
						ts: now(),
						...base,
						type: 'reply_verifier',
						verdict: event.verdict,
						retried: event.retried,
						...(event.reason ? { detail: { reason: event.reason } } : {}),
					});
					break;
				case 'grounding_nudge':
					agentLog.emit({ ts: now(), ...base, type: 'grounding_nudge' });
					break;
				case 'stale_claim_nudge':
					agentLog.emit({ ts: now(), ...base, type: 'stale_claim_nudge' });
					break;
				case 'action_claim_nudge':
					agentLog.emit({ ts: now(), ...base, type: 'action_claim_nudge' });
					break;
				case 'tool_progress':
					agentLog.emit({ ts: now(), ...base, type: 'tool_progress', toolUseId: event.toolUseId, name: event.name, detail: { note: event.note } });
					break;
				case 'subagent_start':
					agentLog.emit({ ts: now(), ...base, type: 'subagent_start', agentId: event.agentId, detail: { task: event.task } });
					break;
				case 'subagent_tool':
					agentLog.emit({ ts: now(), ...base, type: 'subagent_tool', agentId: event.agentId, name: event.name, turn: event.turn, detail: { summary: event.summary } });
					break;
				case 'subagent_end':
					agentLog.emit({
						ts: now(),
						...base,
						type: 'subagent_end',
						agentId: event.agentId,
						reason: event.reason,
						turns: event.turns,
						toolCalls: event.toolCalls,
						tokens: event.tokens,
						outputChars: event.outputChars,
					});
					break;
				case 'compaction_anchor':
					agentLog.emit({ ts: now(), ...base, type: 'compaction_anchor', covered: event.covered, summaryChars: event.summaryChars, accepted: event.accepted });
					break;
				case 'usage':
					// Without this, real token counts reach only the UI meter — logs
					// could never answer "estimate vs actual" questions.
					agentLog.emit({
						ts: now(),
						...base,
						type: 'usage',
						turn,
						inputTokens: event.inputTokens,
						...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
						...(event.cacheReadTokens !== undefined ? { cacheReadTokens: event.cacheReadTokens } : {}),
						...(event.cacheWriteTokens !== undefined ? { cacheWriteTokens: event.cacheWriteTokens } : {}),
					});
					break;
				case 'tool_prune':
					agentLog.emit({ ts: now(), ...base, type: 'tool_prune', prunedResults: event.prunedResults, prunedChars: event.prunedChars });
					break;
				case 'work_digest':
					// Counts are export-safe; the digest text (file paths) stays in detail.
					agentLog.emit({
						ts: now(),
						...base,
						type: 'work_digest',
						filesRead: event.filesRead,
						filesWritten: event.filesWritten,
						toolCalls: event.toolCalls,
						detail: { text: event.text },
					});
					break;
				case 'context_breakdown':
					agentLog.emit({
						ts: now(),
						...base,
						type: 'context_breakdown',
						turn: event.turn,
						systemChars: event.systemChars,
						instructionsChars: event.instructionsChars,
						skillsChars: event.skillsChars,
						toolsChars: event.toolsChars,
						messagesChars: event.messagesChars,
						compactedChars: event.compactedChars,
						prunedChars: event.prunedChars,
					});
					break;
				case 'compaction':
					// Numbers export-safe at the top level; the summary text is
					// conversation content and stays in the local-only detail.
					agentLog.emit({
						ts: now(),
						...base,
						type: 'compaction',
						trigger: event.trigger,
						beforeTokens: event.beforeTokens,
						boundaryIndex: event.boundaryIndex,
						summaryChars: event.summaryChars,
						outcome: event.outcome,
						...(event.summary ? { detail: { summary: event.summary } } : {}),
					});
					break;
				case 'stream_retry':
					agentLog.emit({ ts: now(), ...base, type: 'stream_retry', attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs });
					break;
				default:
					break;
			}
		},
		end(terminal) {
			flushStretch();
			agentLog.emit({ ts: now(), ...base, type: 'run_end', reason: terminal.reason, turns: terminal.turns, durationMs: Date.now() - runStart });
		},
		error(where, message) {
			agentLog.emit({ ts: now(), ...base, type: 'error', where, detail: { message } });
		},
	};
}
