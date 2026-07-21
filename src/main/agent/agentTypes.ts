/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Core contracts for the main-process agent harness.
 *
 * The harness is a single `async function*` loop (see agentLoop.ts) modelled on
 * Claude Code's `queryLoop`: it streams the model, detects `tool_use`, runs the
 * tools behind a fail-closed permission gate, feeds the results back, and loops
 * until a turn produces no tool call. The model client and the tools are
 * injected dependencies so the provider (Claude / GLM / …) plugs in at one seam.
 */

import type { IHook } from './hooks/hooks.js';

// ---------------------------------------------------------------------------
// Message model — provider-agnostic, shaped like Anthropic content blocks.
// tool_result blocks live inside a `user` message (same as the Messages API).
// ---------------------------------------------------------------------------

export interface ITextBlock {
	readonly type: 'text';
	readonly text: string;
}

export interface IToolUseBlock {
	readonly type: 'tool_use';
	readonly id: string;
	readonly name: string;
	readonly input: unknown;
}

export interface IToolResultBlock {
	readonly type: 'tool_result';
	readonly toolUseId: string;
	readonly content: string;
	readonly isError: boolean;
}

/**
 * An extended-thinking block, preserved verbatim (with its signature) so it can
 * be passed back in tool-use loops — the Anthropic API requires this whenever
 * thinking is enabled; dropping the blocks 400s against real Claude models and
 * measurably shallows Kimi's final syntheses. Signature is optional because
 * some Anthropic-compatible providers omit it.
 */
export interface IThinkingBlock {
	readonly type: 'thinking';
	readonly thinking: string;
	readonly signature?: string;
}

/**
 * Thinking the Anthropic safety system encrypted server-side. Same passback
 * rule as IThinkingBlock — a tool-use turn whose reasoning was redacted 400s
 * on the next request if this block is missing. Only the official API emits
 * it (compat providers mimic the wire format but have no redaction pipeline).
 */
export interface IRedactedThinkingBlock {
	readonly type: 'redacted_thinking';
	/** Opaque encrypted payload — round-tripped verbatim, never displayed. */
	readonly data: string;
}

/** An inline image on a user turn. `data` is raw base64 (no data: prefix). */
export interface IImageBlock {
	readonly type: 'image';
	/** e.g. 'image/png', 'image/jpeg', 'image/webp', 'image/gif'. */
	readonly mediaType: string;
	readonly data: string;
}

export type IContentBlock = ITextBlock | IToolUseBlock | IToolResultBlock | IThinkingBlock | IRedactedThinkingBlock | IImageBlock;

export interface IAgentMessage {
	readonly role: 'user' | 'assistant';
	readonly content: readonly IContentBlock[];
}

// ---------------------------------------------------------------------------
// Model client — the inner streaming generator. This is where Claude / GLM /
// any provider plugs in; the loop only depends on this interface.
// ---------------------------------------------------------------------------

export type ModelStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';

export type IModelStreamEvent =
	| { readonly type: 'text_delta'; readonly text: string }
	| { readonly type: 'thinking_delta'; readonly text: string }
	| { readonly type: 'tool_use'; readonly block: IToolUseBlock }
	/** A complete thinking block (text + signature, or the redacted form), emitted at stream end so the loop can preserve it in the transcript. UI streaming stays on thinking_delta; redacted blocks have no deltas. */
	| { readonly type: 'thinking_block'; readonly block: IThinkingBlock | IRedactedThinkingBlock }
	/** The provider's own token count for this turn — ground truth for context-window occupancy. Anthropic-format input_tokens EXCLUDES cache hits, so the cache fields must ride along or occupancy under-counts. */
	| { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens?: number; readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number }
	| { readonly type: 'message_stop'; readonly stopReason: ModelStopReason };

/** The tool schema handed to the model (name + description + JSON Schema). */
export interface IToolSpec {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface IModelRequest {
	readonly system: string;
	readonly messages: readonly IAgentMessage[];
	readonly tools: readonly IToolSpec[];
	readonly signal: AbortSignal;
}

export interface IModelClient {
	stream(request: IModelRequest): AsyncGenerator<IModelStreamEvent, void>;
}

/** Provider-neutral connection config a concrete client is built from. */
export interface IModelClientConfig {
	readonly baseURL: string;
	readonly model: string;
	readonly apiKey?: string;
	readonly params?: {
		readonly temperature?: number;
		readonly maxTokens?: number;
		readonly thinking?: boolean;
		/** Reasoning effort; mapped per wire format, omitted = provider default. */
		readonly effort?: string;
	};
}

// ---------------------------------------------------------------------------
// Tool contract — fail-closed. isReadOnly / isConcurrencySafe default to false
// (see defineTool). The scheduler uses them once concurrency is turned on;
// today every tool runs serially.
// ---------------------------------------------------------------------------

export interface IToolCallContext {
	readonly toolUseId: string;
	readonly signal: AbortSignal;
}

export interface IToolCallResult {
	readonly content: string;
	readonly isError?: boolean;
}

export type IInputValidation = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

export interface IAgentTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
	validateInput(input: unknown): IInputValidation;
	/** Read-only tools are auto-allowed by the approval gate and are parallel-safe. */
	isReadOnly(input: unknown): boolean;
	/** Reserved for the future concurrency scheduler (point 3). */
	isConcurrencySafe(input: unknown): boolean;
	call(input: unknown, context: IToolCallContext): Promise<IToolCallResult>;
}

// ---------------------------------------------------------------------------
// Permission gate — the only decision surface between the model and a tool.
// A non-allow decision becomes an error tool_result fed back to the model; it
// never throws and never halts the loop.
// ---------------------------------------------------------------------------

export type IPermissionDecision = { readonly behavior: 'allow'; readonly updatedInput?: unknown } | { readonly behavior: 'deny'; readonly message: string };

export interface IPermissionContext {
	readonly toolUseId: string;
}

export interface IPermissionGate {
	check(tool: IAgentTool, input: unknown, context: IPermissionContext): Promise<IPermissionDecision>;
}

// ---------------------------------------------------------------------------
// Events the loop yields upward (the renderer maps these to session updates).
// ---------------------------------------------------------------------------

export type IAgentEvent =
	| { readonly type: 'turn_start'; readonly turn: number }
	| { readonly type: 'assistant_delta'; readonly text: string }
	| { readonly type: 'thinking_delta'; readonly text: string }
	/** A REDACTED thinking block arrived (real reasoning, encrypted, no deltas) — the work panel keeps an honest "思考了 Ns" row for it. Streams' latency gaps carry no such event and no longer masquerade as thought. */
	| { readonly type: 'thinking_redacted' }
	| { readonly type: 'assistant_message'; readonly text: string }
	| { readonly type: 'tool_use'; readonly toolUseId: string; readonly name: string; readonly input: unknown }
	| {
			readonly type: 'tool_result';
			readonly toolUseId: string;
			readonly content: string;
			readonly isError: boolean;
			/** The call's measured runtime. Ordered emission in a concurrent batch means arrival time ≠ runtime — step accounting must use this. */
			readonly durationMs?: number;
	  }
	/** The model stream failed before producing output; the loop is backing off and will retry. */
	| { readonly type: 'stream_retry'; readonly attempt: number; readonly maxAttempts: number; readonly delayMs: number }
	/** Real token counts for the turn just completed. The true prompt size is inputTokens + both cache fields (Anthropic wire semantics: input_tokens excludes cache hits) — the renderer's meter and the compaction trigger must sum them. */
	| { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens?: number; readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number }
	/** The loop guard blocked a repeated identical call — logged so trigger/false-positive rates are measurable; the renderer may ignore it. */
	| { readonly type: 'loop_guard'; readonly toolUseId: string; readonly name: string; readonly repeatCount: number }
	/** The reply verifier judged the final answer. verdict 'fail' means a single retry follows — the renderer replaces the rejected reply instead of appending. */
	| { readonly type: 'reply_verifier'; readonly verdict: 'pass' | 'fail' | 'error'; readonly retried: boolean; readonly reason?: string }
	/** A zero-tool-call run quoted code with only digest memory to go on; one forced re-grounded turn follows. The renderer may ignore it. */
	| { readonly type: 'grounding_nudge' }
	/** A spawn_agent child loop started. NEVER yielded by a loop — the tool reports it via a side channel that agentIpc fans out to the run logger AND the renderer. */
	| { readonly type: 'subagent_start'; readonly agentId: string; readonly task: string }
	/** One child tool call — lets the work panel narrate the sub-agent live. Same side channel as subagent_start. */
	| { readonly type: 'subagent_tool'; readonly agentId: string; readonly name: string; readonly summary: string; readonly turn: number }
	/** The child model is streaming (thinking or writing its conclusion) — the liveness signal for a long single request, where tool events go quiet for minutes (#19 缺陷 1). `chars` is cumulative for the current phase within the turn. Same side channel as subagent_start. */
	| { readonly type: 'subagent_progress'; readonly agentId: string; readonly phase: 'thinking' | 'replying'; readonly chars: number }
	/** A spawn_agent child loop finished. Same side channel as subagent_start. */
	| {
			readonly type: 'subagent_end';
			readonly agentId: string;
			readonly reason: string;
			readonly turns: number;
			readonly toolCalls: number;
			readonly tokens: number;
			readonly outputChars: number;
	  }
	/** Mid-execution progress for a long-running tool call (e.g. an SFTP upload) — the work panel live-updates the open step. Same side channel as subagent events. */
	| { readonly type: 'tool_progress'; readonly toolUseId: string; readonly name: string; readonly note: string }
	/** The reply asserted a connection failure without any this-run data-source call; one forced real test follows. The renderer may ignore it. */
	| { readonly type: 'stale_claim_nudge' }
	/** The reply claimed completed actions (deploy/upload/…) in a zero-tool-call run; one forced do-or-retract turn follows. The renderer may ignore it. */
	| { readonly type: 'action_claim_nudge' }
	/** Old tool outputs aged out of the request view (history/UI keep full text). Emitted only when the pruned set grows — roughly once per quantum. */
	| { readonly type: 'tool_prune'; readonly prunedResults: number; readonly prunedChars: number }
	/** A run's deterministic work digest (files read/changed + activity counts). `text` is persisted as a hidden message and carried on the next run's transcript to pay down the re-exploration tax; the counts are export-safe telemetry. Emitted once at run end, only when the run touched something. */
	| { readonly type: 'work_digest'; readonly text: string; readonly filesRead: number; readonly filesWritten: number; readonly toolCalls: number }
	/** The transcript head was folded into an anchored summary (request view only; history intact). `summary` feeds the local log's detail; the renderer persists `summary`+`coveredInitial` as the cross-run anchor. */
	| {
			readonly type: 'compaction';
			readonly trigger: 'preflight' | 'auto';
			readonly beforeTokens: number;
			readonly boundaryIndex: number;
			readonly summaryChars: number;
			readonly outcome: 'ok' | 'error' | 'insufficient';
			readonly summary?: string;
			/** How many of the run's INITIAL messages the summary covers — the cross-run persistence contract (in-run indices don't survive the run). */
			readonly coveredInitial?: number;
	  }
	/** A persisted anchor arrived with the run; accepted=false means a validation gate rejected it (fresh preflight follows). Log-only — never streamed to the renderer. */
	| { readonly type: 'compaction_anchor'; readonly covered: number; readonly summaryChars: number; readonly accepted: boolean }
	/**
	 * What the request view is made of, right after this turn's view was
	 * assembled (compaction → prepareRequestMessages → prune → brake reminder).
	 * All char counts — the renderer's context panel divides by ~4 for a rough
	 * token estimate and labels it "estimated"; only the usage event's token
	 * counts are real. Emitted every turn so a panel open mid-run shows the
	 * mechanisms working live (tool output aging, compaction folding, etc).
	 */
	| {
			readonly type: 'context_breakdown';
			readonly turn: number;
			readonly systemChars: number;
			readonly instructionsChars: number;
			readonly skillsChars: number;
			readonly toolsChars: number;
			readonly messagesChars: number;
			readonly compactedChars: number;
			readonly prunedChars: number;
	  };

/**
 * A compaction summary persisted across runs. `covered` counts the prefix of
 * the NEXT run's initial transcript the summary stands in for; `prefixChars`
 * is that prefix's content size when the anchor was made — a cheap integrity
 * check that drops the anchor whenever the covered history changed.
 */
export interface ICompactionAnchor {
	readonly summary: string;
	readonly covered: number;
	readonly prefixChars: number;
}

/** 'max_output_tokens': the reply was cut off by the max_tokens budget — surfaced explicitly so truncation shows up in logs instead of masquerading as 'completed'. 'paused': quota/rate exhaustion froze the run resumable (#19 缺陷 2) — see IAgentTerminal.paused. */
export type AgentStopReason = 'completed' | 'aborted' | 'max_turns' | 'max_output_tokens' | 'refusal' | 'paused';

/**
 * A resumable pause (#19 缺陷 2, route b): quota exhaustion is a waiting
 * state, not a failure. The frozen transcript is the loop's message history
 * at the pause point — including every tool_result already collected but not
 * yet consumed by the model (the six sub-agent reports of the 2026-07-18
 * incident). Resume = run again with this transcript verbatim; the model
 * continues from mid-run as if the wall had never been hit.
 */
export interface IAgentPause {
	/** 'quota': hard 403 (weekly quota / permissions — fast-stopped on first hit). 'rate_limit': 429 that survived the full retry ladder (usually the 5h window). */
	readonly cause: 'quota' | 'rate_limit';
	/** The original transport error, for the humanized copy. */
	readonly message: string;
	/** Resend verbatim to continue. Never partial: a turn interrupted mid-stream is excluded (it regenerates on resume). */
	readonly frozenTranscript: readonly IAgentMessage[];
	/** ISO time the relevant window refreshes — attached by the caller when the usage endpoint answers; drives auto-resume. */
	readonly resetTime?: string;
}

export interface IAgentTerminal {
	readonly reason: AgentStopReason;
	readonly turns: number;
	/** Present iff reason === 'paused'. */
	readonly paused?: IAgentPause;
}

export interface IAgentRunConfig {
	readonly system: string;
	readonly tools: readonly IAgentTool[];
	readonly modelClient: IModelClient;
	readonly permissionGate: IPermissionGate;
	readonly maxTurns?: number;
	readonly signal?: AbortSignal;
	/**
	 * Skip the reply-verifier judge call for this run. Set for sub-agent loops:
	 * their conclusion is consumed by the PARENT model (which can re-delegate or
	 * dig further itself), so a topical-relevance retry buys nothing but latency.
	 */
	readonly disableReplyVerifier?: boolean;
	/**
	 * User-configured hooks (design docs/design/hooks §10 M3), already loaded and
	 * trust-gated by the caller. They register AFTER the built-in hooks (§4 — the
	 * built-ins are the safety/correctness floor). Only hooks for events with a
	 * live dispatch point (Stop, PreToolUse) fire today.
	 */
	readonly userHooks?: readonly IHook[];
	/**
	 * Marks a TOP-LEVEL pausable run (#19 缺陷 2): quota/rate exhaustion
	 * returns a 'paused' terminal with the frozen transcript instead of dying.
	 * Absent for child loops — a child that exhausts its retries fails as an
	 * error tool_result and the PARENT pauses (with the child's partial results
	 * already frozen into its transcript).
	 */
	readonly pauseOnExhaustion?: {
		/**
		 * The fast-stop bridge: the shared model-client wrapper aborts the run's
		 * signal on the first quota 403 and this callback returns that error's
		 * message — telling the loop the abort means PAUSE, not user-stop.
		 */
		readonly quotaHit: () => string | undefined;
	};
	/** Test seam: base delay of the stream-retry backoff ladder (default 1s). The 429-exhaustion path needs all 10 rungs — real delays would make its test take a minute. */
	readonly streamRetryBaseDelayMs?: number;
	/**
	 * How `system` is composed, broken into the context panel's rows. The caller
	 * assembles `system` from these same segments, so the lengths are exact, not
	 * re-derived. Absent segments (no workspace, no instructions, no skills) are 0.
	 */
	readonly systemBreakdown?: { readonly baseChars: number; readonly instructionsChars: number; readonly skillsChars: number };
	/**
	 * Point 5 seam: transform the growing transcript into the messages actually
	 * sent to the model. Identity today; the future home for provider-side
	 * context editing. Compaction runs before this seam and feeds it the
	 * already-compacted view.
	 */
	readonly prepareRequestMessages?: (messages: readonly IAgentMessage[]) => readonly IAgentMessage[];
	/**
	 * Enables auto-compaction. Absent (model has no configured context window)
	 * means the mechanism stays off — the threshold is never guessed.
	 * `anchor` (validated by the caller via restoreAnchor) pre-seeds the run
	 * with a persisted summary so the same head is never re-summarized.
	 */
	readonly compaction?: { readonly contextWindow: number; readonly outputBudget?: number; readonly anchor?: ICompactionAnchor };
}
