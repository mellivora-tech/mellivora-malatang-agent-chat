export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed';
export type MessageRole = 'user' | 'assistant' | 'system';
export type ToolStatus = 'pending' | 'completed' | 'failed';

export interface AgentSession {
	id: string;
	title: string;
	providerName: string;
	status: SessionStatus;
	workspaceLabel: string;
	updatedAt: string;
	pinned: boolean;
	unread: boolean;
	archived: boolean;
}

export interface ChatMessage {
	id: string;
	sessionId: string;
	turnId: string;
	role: MessageRole;
	content: string;
	createdAt: string;
	streaming?: boolean;
	failed?: boolean;
}

export interface ToolCall {
	id: string;
	sessionId: string;
	turnId: string;
	title: string;
	description: string;
	status: ToolStatus;
}

export interface FileChange {
	id: string;
	sessionId: string;
	path: string;
	status: 'modified' | 'added' | 'deleted';
	additions: number;
	deletions: number;
}

export interface SessionFile {
	id: string;
	sessionId: string;
	path: string;
	type: 'file' | 'folder';
	depth: number;
}

export interface CreateSessionInput {
	title?: string;
	workspaceLabel?: string;
}

export interface SendMessageInput {
	text: string;
}

export type AgentEvent =
	| { type: 'message.created'; sessionId: string; turnId: string; message: ChatMessage }
	| { type: 'message.delta'; sessionId: string; turnId: string; messageId: string; delta: string }
	| { type: 'message.completed'; sessionId: string; turnId: string; messageId: string }
	| { type: 'tool.pending'; sessionId: string; turnId: string; toolCall: ToolCall }
	| { type: 'tool.completed'; sessionId: string; turnId: string; toolCallId: string }
	| { type: 'session.updated'; session: AgentSession };

export interface AgentProvider {
	listSessions(): Promise<AgentSession[]>;
	createSession(input: CreateSessionInput): Promise<AgentSession>;
	sendMessage(sessionId: string, input: SendMessageInput): AsyncIterable<AgentEvent>;
	cancelTurn(sessionId: string, turnId: string): Promise<void>;
}
