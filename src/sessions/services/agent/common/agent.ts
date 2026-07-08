/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The harness message/event contracts are the single source of truth (main
// process). These are type-only re-exports — erased at runtime, so the renderer
// gains no runtime dependency on the main bundle.
import type { IAgentEvent, IAgentMessage, IAgentTerminal } from '../../../../main/agent/agentTypes.js';

export type { IAgentEvent, IAgentMessage, IAgentTerminal };

export interface IAgentEventPayload {
	readonly sessionId: string;
	readonly event?: IAgentEvent;
	/** Sent once on the same channel after the last event, to preserve ordering. */
	readonly done?: IAgentTerminal;
}

/** The shape exposed on `agentWindow.agent` by the preload script. */
export interface IAgentBridge {
	/** Run one agent turn for `sessionId` against `messages`, streaming events; resolves with the terminal.
	 *  `projectId` binds the run's file tools to that project's directory (omit → text-only). */
	run(sessionId: string, messages: readonly IAgentMessage[], modelId?: string, projectId?: string): Promise<IAgentTerminal>;
	stop(sessionId: string): Promise<void>;
	/** Subscribe to streamed events; returns an unsubscribe function. */
	onEvent(listener: (payload: IAgentEventPayload) => void): () => void;
}
