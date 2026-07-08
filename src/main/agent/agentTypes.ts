/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
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

export type IContentBlock = ITextBlock | IToolUseBlock | IToolResultBlock;

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
	| { readonly type: 'stream_retry'; readonly attempt: number; readonly maxAttempts: number; readonly delayMs: number };

export type AgentStopReason = 'completed' | 'aborted' | 'max_turns' | 'refusal';

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
	 * Point 5 seam: transform the growing transcript into the messages actually
	 * sent to the model. Identity today; the future home for compaction / context
	 * editing (or a pass-through to the provider's server-side compaction).
	 */
	readonly prepareRequestMessages?: (messages: readonly IAgentMessage[]) => readonly IAgentMessage[];
}
