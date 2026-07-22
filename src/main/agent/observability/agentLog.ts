/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Structured observability for the agent loop — the P1 foundation for later
 * ops/product sinks (OpenTelemetry, analytics). One event stream, fanned out to
 * attached sinks.
 *
 * PII boundary: every event's TOP-LEVEL fields are export-safe (types, names,
 * counts, durations, booleans, classifications). Anything that could carry the
 * user's code, paths, prompts, or command text lives under `detail`, which the
 * local file sink keeps but any off-machine sink MUST drop via {@link toExportable}.
 */

interface IBaseEvent {
	readonly ts: string;
	readonly runId: string;
	readonly sessionId: string;
}

/**
 * Base for events that belong to NO agent run. Every other event rides a run
 * (runId + sessionId); auxiliary IPC work — title generation, provider probes,
 * data-source tests — has neither, which is precisely why it could never be
 * logged before: the type had no shape to express it, so 63 of the 64 IPC
 * handlers left no trace on disk when they failed.
 */
interface IAuxBaseEvent {
	readonly ts: string;
}

export type AgentLogEvent =
	| (IBaseEvent & {
			readonly type: 'run_start';
			/** Git sha of the build that produced this run ('dev' un-bundled) — catches stale-binary runs. */
			readonly build: string;
			readonly model: string;
			readonly mode: string;
			readonly hasWorkspace: boolean;
			readonly toolCount: number;
			/** Absent = auto-compaction disabled for this run (no configured window). */
			readonly contextWindow?: number;
			readonly detail?: {
				readonly cwd?: string;
				readonly projectId?: string;
				readonly instructions?: { readonly file: string; readonly chars: number; readonly truncated: boolean };
			};
	  })
	| (IBaseEvent & { readonly type: 'turn_start'; readonly turn: number })
	| (IBaseEvent & { readonly type: 'ttft'; readonly turn: number; readonly ttftMs: number })
	/**
	 * One contiguous run of same-kind deltas (all 'thinking' or all 'text'),
	 * closed the moment the stream switches kind, calls a tool, or the run ends.
	 * A 'thinking' stretch appearing AFTER a 'text' stretch in the same turn
	 * means the model kept reasoning after it had already started answering.
	 */
	| (IBaseEvent & {
			readonly type: 'reasoning_stretch';
			readonly turn: number;
			readonly kind: 'thinking' | 'text';
			readonly durationMs: number;
			readonly chars: number;
			readonly detail?: { readonly text: string };
	  })
	| (IBaseEvent & { readonly type: 'tool_use'; readonly toolUseId: string; readonly name: string; readonly detail?: { readonly input: unknown } })
	/**
	 * The loop guard blocked a repeated identical call. Top-level fields only —
	 * the offending input is already on the adjacent tool_use event's detail.
	 * Watch this event's rate in real logs to judge trigger/false-positive rates.
	 */
	| (IBaseEvent & { readonly type: 'loop_guard'; readonly toolUseId: string; readonly name: string; readonly repeatCount: number })
	/**
	 * The reply verifier's judgment on a finished run. verdict/retried are
	 * export-safe; the judge's free-text reason (derived from user content)
	 * stays under detail. Watch fail rates in real logs to tune or disable.
	 */
	| (IBaseEvent & { readonly type: 'reply_verifier'; readonly verdict: 'pass' | 'fail' | 'error'; readonly retried: boolean; readonly detail?: { readonly reason?: string } })
	/** A zero-tool-call run quoted code from digest memory and was forced to re-ground. Watch the rate: frequent firing means models keep skipping re-reads. */
	| (IBaseEvent & { readonly type: 'grounding_nudge' })
	/** A reply asserted a connection failure with no this-run data-source call and was forced to actually test. Watch alongside grounding_nudge. */
	| (IBaseEvent & { readonly type: 'stale_claim_nudge' })
	/** A zero-tool-call reply claimed completed actions and was forced to do-or-retract. Watch the family's rates together. */
	| (IBaseEvent & { readonly type: 'action_claim_nudge' })
	/** A hook fired with a consequence (§9): user hooks + any block/inject. Names + decision are export-safe telemetry; watch to see what the harness enforced and when. */
	/**
	 * A store that EXISTED but could not be used, so it degraded to empty/partial.
	 *
	 * This is the difference between "you never configured this" and "your config
	 * is unreadable" — states the app otherwise renders identically. A corrupt
	 * models.json shows "No model is configured"; an undecryptable credential file
	 * makes every API key look like it was never entered; a bad session header makes
	 * a whole conversation disappear from the list. An absent file is NOT reported:
	 * that one really is the legitimate empty case.
	 */
	| (IAuxBaseEvent & {
			readonly type: 'storage_degraded';
			readonly store: string;
			readonly reason: 'unparseable' | 'undecryptable' | 'entries-dropped';
			/** How many records were discarded, for 'entries-dropped'. */
			readonly dropped?: number;
			readonly detail?: { readonly path?: string; readonly message?: string };
	  })
	/**
	 * A failure the RENDERER caught. Its `console.warn` reaches only DevTools, so
	 * without this the whole `src/sessions/**` half of the app could fail silently
	 * with nothing on disk. `sessionId` is optional because much of the renderer
	 * (project list, skills, artifacts) fails outside any session.
	 */
	| (IAuxBaseEvent & {
			readonly type: 'renderer_error';
			readonly scope: string;
			readonly sessionId?: string;
			readonly errorClass?: string;
			readonly detail?: { readonly message: string };
	  })
	/**
	 * The user-hook load result. Emitted only when a hooks file had content, so a
	 * dropped entry (typo'd event name) or an unparseable file is visible instead
	 * of presenting as "the hook just never fires".
	 */
	| (IBaseEvent & { readonly type: 'hooks_loaded'; readonly loaded: number; readonly dropped: number; readonly corrupt: boolean })
	/** `failOpen` marks a hook that did not really run (spawn/timeout/crash) yet still allowed — a silently broken hook. */
	| (IBaseEvent & {
			readonly type: 'hook';
			readonly event: string;
			readonly hookId: string;
			readonly decision: 'allow' | 'block' | 'modify';
			readonly injected?: boolean;
			readonly failOpen?: boolean;
	  })
	/** A spawn_agent child loop started. The task text (user-adjacent content) stays in detail. */
	| (IBaseEvent & { readonly type: 'subagent_start'; readonly agentId: string; readonly detail?: { readonly task: string } })
	/** One child tool call — the child's whole activity trace, since its loop events never reach the log directly. The summary (paths/patterns) stays in detail. */
	| (IBaseEvent & { readonly type: 'subagent_tool'; readonly agentId: string; readonly name: string; readonly turn: number; readonly detail?: { readonly summary: string } })
	/** The child model is mid-stream (throttled) — the liveness trace for a multi-minute single request, which previously logged nothing between subagent_tool and subagent_end. Counts only; no content. */
	| (IBaseEvent & { readonly type: 'subagent_progress'; readonly agentId: string; readonly phase: 'thinking' | 'replying'; readonly chars: number })
	/** Mid-call progress for a long-running tool (SFTP upload). The note (paths, rates) stays in detail. */
	| (IBaseEvent & { readonly type: 'tool_progress'; readonly toolUseId: string; readonly name: string; readonly detail?: { readonly note: string } })
	/** A spawn_agent child loop finished. Watch outputChars≈0 rate (misfired delegations) and tokens (delegation cost). */
	| (IBaseEvent & {
			readonly type: 'subagent_end';
			readonly agentId: string;
			readonly reason: string;
			readonly turns: number;
			readonly toolCalls: number;
			readonly tokens: number;
			readonly outputChars: number;
	  })
	/** Real provider token counts for one turn — the ground truth the compaction threshold and the UI meter read. True prompt size = input + cacheRead + cacheWrite. */
	| (IBaseEvent & {
			readonly type: 'usage';
			readonly turn: number;
			readonly inputTokens: number;
			readonly outputTokens?: number;
			readonly cacheReadTokens?: number;
			readonly cacheWriteTokens?: number;
	  })
	/** A persisted cross-run anchor arrived; watch the rejected rate — it should be ≈0 outside history edits. */
	| (IBaseEvent & { readonly type: 'compaction_anchor'; readonly covered: number; readonly summaryChars: number; readonly accepted: boolean })
	/** What this turn's request view is made of, in chars — mirrors the renderer's context panel so log reviews can see the same breakdown without the UI. */
	| (IBaseEvent & {
			readonly type: 'context_breakdown';
			readonly turn: number;
			readonly systemChars: number;
			readonly instructionsChars: number;
			readonly skillsChars: number;
			readonly toolsChars: number;
			readonly messagesChars: number;
			readonly compactedChars: number;
			readonly prunedChars: number;
	  })
	/** Tool outputs aged out of the request view. Counts only — the full content stays in the adjacent tool_result events. */
	| (IBaseEvent & { readonly type: 'tool_prune'; readonly prunedResults: number; readonly prunedChars: number })
	/** A run's work digest was sunk. Counts are export-safe; the digest text carries file paths, so it lives under detail. */
	| (IBaseEvent & {
			readonly type: 'work_digest';
			readonly filesRead: number;
			readonly filesWritten: number;
			readonly toolCalls: number;
			readonly detail?: { readonly text: string };
	  })
	/**
	 * The transcript head was folded into an anchored summary. Trigger math and
	 * sizes are export-safe; the summary text (conversation content) is detail.
	 */
	| (IBaseEvent & {
			readonly type: 'compaction';
			readonly trigger: 'preflight' | 'auto';
			readonly beforeTokens: number;
			readonly boundaryIndex: number;
			readonly summaryChars: number;
			readonly outcome: 'ok' | 'error' | 'insufficient';
			readonly detail?: { readonly summary: string };
	  })
	| (IBaseEvent & {
			readonly type: 'tool_result';
			readonly toolUseId: string;
			readonly name: string;
			readonly ok: boolean;
			readonly durationMs: number;
			readonly outputBytes: number;
			readonly detail?: { readonly output: string };
	  })
	| (IBaseEvent & { readonly type: 'stream_retry'; readonly attempt: number; readonly maxAttempts: number; readonly delayMs: number })
	| (IBaseEvent & { readonly type: 'error'; readonly where: 'model' | 'tool' | 'run'; readonly detail?: { readonly message: string } })
	| (IBaseEvent & { readonly type: 'run_end'; readonly reason: string; readonly turns: number; readonly durationMs: number })
	/**
	 * One IPC handler call that either FAILED or ran slowly. Emitted by the
	 * `registerHandler` wrapper, so coverage is structural rather than per-handler
	 * discipline. Successes below the slow threshold are not logged — the point is
	 * failure forensics and latency outliers, not one line per keystroke.
	 * `errorClass` is a constructor name (export-safe); the message may carry paths
	 * or user content, so it stays under local-only `detail`.
	 */
	| (IAuxBaseEvent & {
			readonly type: 'ipc';
			readonly channel: string;
			readonly ok: boolean;
			readonly durationMs: number;
			readonly errorClass?: string;
			readonly detail?: { readonly message: string };
	  });

/** Strip local-only `detail` so an event is safe to send off the machine. */
export function toExportable(event: AgentLogEvent): AgentLogEvent {
	if ('detail' in event && event.detail !== undefined) {
		const { detail: _detail, ...rest } = event;
		return rest as AgentLogEvent;
	}
	return event;
}

export interface IAgentLogSink {
	write(event: AgentLogEvent): void;
	flush?(): void;
	dispose?(): void;
}

const MAX_QUEUED_EVENTS = 1000;

/**
 * The event bus. `emit` is dependency-free and buffers events until a sink is
 * attached (queue-then-attach, so early events are not lost); once sinks exist
 * it fans out to all of them. A sink that throws never affects the loop.
 */
class AgentLog {
	private readonly sinks: IAgentLogSink[] = [];
	private queue: AgentLogEvent[] = [];

	attach(sink: IAgentLogSink): void {
		this.sinks.push(sink);
		if (this.queue.length > 0) {
			const pending = this.queue;
			this.queue = [];
			for (const event of pending) {
				this.safeWrite(sink, event);
			}
		}
	}

	emit(event: AgentLogEvent): void {
		if (this.sinks.length === 0) {
			if (this.queue.length < MAX_QUEUED_EVENTS) {
				this.queue.push(event);
			}
			return;
		}
		for (const sink of this.sinks) {
			this.safeWrite(sink, event);
		}
	}

	flush(): void {
		for (const sink of this.sinks) {
			sink.flush?.();
		}
	}

	dispose(): void {
		for (const sink of this.sinks) {
			sink.dispose?.();
		}
		this.sinks.length = 0;
	}

	private safeWrite(sink: IAgentLogSink, event: AgentLogEvent): void {
		try {
			sink.write(event);
		} catch {
			// A logging failure must never break the agent loop.
		}
	}
}

/** The process-wide agent event bus. */
export const agentLog = new AgentLog();
