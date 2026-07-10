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
 * some Anthropic-compatible providers omit it. (`redacted_thinking` is a known
 * remaining gap — rare, safety-triggered, not emitted by Kimi.)
 */
export interface IThinkingBlock {
	readonly type: 'thinking';
	readonly thinking: string;
	readonly signature?: string;
}

/** An inline image on a user turn. `data` is raw base64 (no data: prefix). */
export interface IImageBlock {
	readonly type: 'image';
	/** e.g. 'image/png', 'image/jpeg', 'image/webp', 'image/gif'. */
	readonly mediaType: string;
	readonly data: string;
}

export type IContentBlock = ITextBlock | IToolUseBlock | IToolResultBlock | IThinkingBlock | IImageBlock;

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
	/** A complete thinking block (text + signature), emitted at stream end so the loop can preserve it in the transcript. UI streaming stays on thinking_delta. */
	| { readonly type: 'thinking_block'; readonly block: IThinkingBlock }
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
	| { readonly type: 'assistant_message'; readonly text: string }
	| { readonly type: 'tool_use'; readonly toolUseId: string; readonly name: string; readonly input: unknown }
	| { readonly type: 'tool_result'; readonly toolUseId: string; readonly content: string; readonly isError: boolean }
	/** The model stream failed before producing output; the loop is backing off and will retry. */
	| { readonly type: 'stream_retry'; readonly attempt: number; readonly maxAttempts: number; readonly delayMs: number }
	/** Real token counts for the turn just completed. The true prompt size is inputTokens + both cache fields (Anthropic wire semantics: input_tokens excludes cache hits) — the renderer's meter and the compaction trigger must sum them. */
	| { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens?: number; readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number }
	/** The loop guard blocked a repeated identical call — logged so trigger/false-positive rates are measurable; the renderer may ignore it. */
	| { readonly type: 'loop_guard'; readonly toolUseId: string; readonly name: string; readonly repeatCount: number }
	/** The reply verifier judged the final answer. verdict 'fail' means a single retry follows — the renderer replaces the rejected reply instead of appending. */
	| { readonly type: 'reply_verifier'; readonly verdict: 'pass' | 'fail' | 'error'; readonly retried: boolean; readonly reason?: string }
	/** Old tool outputs aged out of the request view (history/UI keep full text). Emitted only when the pruned set grows — roughly once per quantum. */
	| { readonly type: 'tool_prune'; readonly prunedResults: number; readonly prunedChars: number }
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

/** 'max_output_tokens': the reply was cut off by the max_tokens budget — surfaced explicitly so truncation shows up in logs instead of masquerading as 'completed'. */
export type AgentStopReason = 'completed' | 'aborted' | 'max_turns' | 'max_output_tokens' | 'refusal';

export interface IAgentTerminal {
	readonly reason: AgentStopReason;
	readonly turns: number;
}

export interface IAgentRunConfig {
	readonly system: string;
	readonly tools: readonly IAgentTool[];
	readonly modelClient: IModelClient;
	readonly permissionGate: IPermissionGate;
	readonly maxTurns?: number;
	readonly signal?: AbortSignal;
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
