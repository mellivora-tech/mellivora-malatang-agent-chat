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

export type AgentLogEvent =
	| (IBaseEvent & {
			readonly type: 'run_start';
			readonly model: string;
			readonly mode: string;
			readonly hasWorkspace: boolean;
			readonly toolCount: number;
			readonly detail?: { readonly cwd?: string; readonly projectId?: string };
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
	| (IBaseEvent & { readonly type: 'run_end'; readonly reason: string; readonly turns: number; readonly durationMs: number });

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
