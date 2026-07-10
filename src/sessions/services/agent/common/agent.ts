/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The harness message/event contracts are the single source of truth (main
// process). These are type-only re-exports — erased at runtime, so the renderer
// gains no runtime dependency on the main bundle.
import type { IAgentEvent, IAgentMessage, IAgentTerminal } from '../../../../main/agent/agentTypes.js';
import type { PermissionMode } from '../../../../main/agent/permission.js';

export type { IAgentEvent, IAgentMessage, IAgentTerminal, PermissionMode };

export interface IAgentEventPayload {
	readonly sessionId: string;
	readonly event?: IAgentEvent;
	/** Sent once on the same channel after the last event, to preserve ordering. */
	readonly done?: IAgentTerminal;
}

/** A mutating tool call waiting for the user's allow / deny. */
export interface IApprovalRequestPayload {
	readonly sessionId: string;
	readonly requestId: string;
	readonly toolName: string;
	/** One-line summary of what the tool wants to do (command, file path…). */
	readonly detail: string;
}

/** The shape exposed on `agentWindow.agent` by the preload script. */
export interface IAgentBridge {
	/** Run one agent turn for `sessionId` against `messages`, streaming events; resolves with the terminal.
	 *  `projectId` binds the run's file tools to that project's directory (omit → text-only);
	 *  `permissionMode` picks the gate for mutating tools (default 'ask');
	 *  `skillIds` are $-attached skills whose bodies ride the system prompt. */
	run(sessionId: string, messages: readonly IAgentMessage[], modelId?: string, projectId?: string, permissionMode?: PermissionMode, skillIds?: readonly string[]): Promise<IAgentTerminal>;
	stop(sessionId: string): Promise<void>;
	/** One-shot session title from the first user message — a plain model call, no agent loop.
	 *  Resolves to undefined when no model is configured or the reply is unusable; rejects on model errors.
	 *  Optional so test doubles that only exercise `run` stay valid. */
	generateTitle?(query: string, modelId?: string): Promise<string | undefined>;
	/** Subscribe to streamed events; returns an unsubscribe function. */
	onEvent(listener: (payload: IAgentEventPayload) => void): () => void;
	/** Subscribe to approval requests from the permission gate; returns an unsubscribe function. */
	onApprovalRequest(listener: (payload: IApprovalRequestPayload) => void): () => void;
	/** Answer an approval request. Unanswered requests are denied when the run ends. */
	respondApproval(requestId: string, approved: boolean): Promise<void>;
}
