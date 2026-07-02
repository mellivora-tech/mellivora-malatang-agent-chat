import { seedFileChangesBySessionId, seedFilesBySessionId, seedMessagesBySessionId, seedSessions } from './mockData';
import type { AgentEvent, AgentProvider, AgentSession, ChatMessage, CreateSessionInput, SendMessageInput, ToolCall } from './types';

export interface MockProviderOptions {
	chunkDelayMs?: number;
}

const responseChunks = [
	'I inspected the mock workspace and found a narrow path forward. ',
	'The safest first change is to isolate the UI state from provider events. ',
	'After that, the renderer can stay deterministic while the provider streams updates.'
];

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function createMockAgentProvider(options: MockProviderOptions = {}): AgentProvider {
	const chunkDelayMs = options.chunkDelayMs ?? 180;
	const sessions = new Map(seedSessions.map(session => [session.id, { ...session }]));
	const messagesBySessionId = new Map(Object.entries(seedMessagesBySessionId).map(([id, messages]) => [id, messages.map(message => ({ ...message }))]));
	const fileChangesBySessionId = new Map(
		Object.entries(seedFileChangesBySessionId).map(([id, fileChanges]) => [id, fileChanges.map(fileChange => ({ ...fileChange }))])
	);
	const filesBySessionId = new Map(
		Object.entries(seedFilesBySessionId).map(([id, files]) => [id, files.map(file => ({ ...file }))])
	);
	const inFlightTurnIds = new Set<string>();
	let turnCounter = 1;

	return {
		async listSessions() {
			return [...sessions.values()].map(session => ({ ...session }));
		},

		async createSession(input: CreateSessionInput) {
			const nextNumber = sessions.size + 1;
			const session: AgentSession = {
				id: `session-new-${nextNumber}`,
				title: input.title?.trim() || `New Session ${nextNumber}`,
				providerName: 'Mock Agent',
				status: 'idle',
				workspaceLabel: input.workspaceLabel?.trim() || 'mock-workspace',
				updatedAt: new Date().toISOString(),
				pinned: false,
				unread: false,
				archived: false
			};

			sessions.set(session.id, session);
			messagesBySessionId.set(session.id, []);
			fileChangesBySessionId.set(session.id, []);
			filesBySessionId.set(session.id, []);
			return { ...session };
		},

		async *sendMessage(sessionId: string, input: SendMessageInput): AsyncIterable<AgentEvent> {
			const session = sessions.get(sessionId);
			if (!session) {
				throw new Error(`Unknown session: ${sessionId}`);
			}

			const turnId = `turn-${turnCounter++}`;
			const messageId = `msg-${turnId}`;
			inFlightTurnIds.add(turnId);

			const assistantMessage: ChatMessage = {
				id: messageId,
				sessionId,
				turnId,
				role: 'assistant',
				content: '',
				createdAt: new Date().toISOString(),
				streaming: true
			};

			const runningSession: AgentSession = { ...session, status: 'running', updatedAt: new Date().toISOString(), unread: false };
			sessions.set(sessionId, runningSession);

			yield { type: 'message.created', sessionId, turnId, message: assistantMessage };
			yield { type: 'session.updated', session: { ...runningSession } };

			const toolCall: ToolCall = {
				id: `tool-${turnId}`,
				sessionId,
				turnId,
				title: 'Inspect Mock Workspace',
				description: `Read mock context for "${input.text}"`,
				status: 'pending'
			};

			yield { type: 'tool.pending', sessionId, turnId, toolCall };

			for (const delta of responseChunks) {
				if (!inFlightTurnIds.has(turnId)) break;
				await delay(chunkDelayMs);
				if (!inFlightTurnIds.has(turnId)) break;
				yield { type: 'message.delta', sessionId, turnId, messageId, delta };
			}

			if (!inFlightTurnIds.has(turnId)) {
				inFlightTurnIds.delete(turnId);
				return;
			}

			yield { type: 'tool.completed', sessionId, turnId, toolCallId: toolCall.id };
			yield { type: 'message.completed', sessionId, turnId, messageId };

			inFlightTurnIds.delete(turnId);
			const completedSession: AgentSession = { ...runningSession, status: 'completed', updatedAt: new Date().toISOString() };
			sessions.set(sessionId, completedSession);
			yield { type: 'session.updated', session: { ...completedSession } };
		},

		async cancelTurn(_sessionId: string, turnId: string) {
			inFlightTurnIds.delete(turnId);
		}
	};
}
