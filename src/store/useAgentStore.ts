import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { createMockAgentProvider } from '../domain/mockProvider';
import type {
	AgentEvent,
	AgentProvider,
	AgentSession,
	ChatMessage,
	FileChange,
	SessionFile,
	ToolCall
} from '../domain/types';
import { seedFileChangesBySessionId, seedFilesBySessionId, seedMessagesBySessionId } from '../domain/mockData';

export type AuxiliaryTab = 'changes' | 'files' | 'details';

export interface AgentState {
	provider: AgentProvider;
	initialized: boolean;
	sessionsById: Record<string, AgentSession>;
	sessionOrder: string[];
	activeSessionId: string | null;
	messagesBySessionId: Record<string, ChatMessage[]>;
	toolCallsBySessionId: Record<string, ToolCall[]>;
	fileChangesBySessionId: Record<string, FileChange[]>;
	filesBySessionId: Record<string, SessionFile[]>;
	draftsBySessionId: Record<string, string>;
	activeAuxiliaryTab: AuxiliaryTab;
	inFlightTurnsBySessionId: Record<string, string>;
	initialize(): Promise<void>;
	createSession(): Promise<void>;
	selectSession(sessionId: string): void;
	setDraft(sessionId: string, value: string): void;
	setActiveAuxiliaryTab(tab: AuxiliaryTab): void;
	sendMessage(sessionId: string): Promise<void>;
	cancelTurn(sessionId: string): Promise<void>;
	applyEvent(event: AgentEvent): void;
}

export function createAgentStore(provider: AgentProvider): UseBoundStore<StoreApi<AgentState>> {
	return create<AgentState>((set, get) => ({
		provider,
		initialized: false,
		sessionsById: {},
		sessionOrder: [],
		activeSessionId: null,
		messagesBySessionId: {},
		toolCallsBySessionId: {},
		fileChangesBySessionId: {},
		filesBySessionId: {},
		draftsBySessionId: {},
		activeAuxiliaryTab: 'changes',
		inFlightTurnsBySessionId: {},

		async initialize() {
			const sessions = await get().provider.listSessions();
			const sessionsById = Object.fromEntries(sessions.map(session => [session.id, session]));
			const sessionOrder = sessions.map(session => session.id);
			set({
				initialized: true,
				sessionsById,
				sessionOrder,
				activeSessionId: sessionOrder[0] ?? null,
				messagesBySessionId: cloneRecord(seedMessagesBySessionId),
				toolCallsBySessionId: {},
				fileChangesBySessionId: cloneRecord(seedFileChangesBySessionId),
				filesBySessionId: cloneRecord(seedFilesBySessionId),
				draftsBySessionId: {},
				inFlightTurnsBySessionId: {}
			});
		},

		async createSession() {
			const session = await get().provider.createSession({});
			set(state => ({
				sessionsById: { ...state.sessionsById, [session.id]: session },
				sessionOrder: [session.id, ...state.sessionOrder],
				activeSessionId: session.id,
				messagesBySessionId: { ...state.messagesBySessionId, [session.id]: [] },
				fileChangesBySessionId: { ...state.fileChangesBySessionId, [session.id]: [] },
				filesBySessionId: { ...state.filesBySessionId, [session.id]: [] },
				draftsBySessionId: { ...state.draftsBySessionId, [session.id]: '' }
			}));
		},

		selectSession(sessionId: string) {
			set({ activeSessionId: sessionId });
		},

		setDraft(sessionId: string, value: string) {
			set(state => ({
				draftsBySessionId: { ...state.draftsBySessionId, [sessionId]: value }
			}));
		},

		setActiveAuxiliaryTab(tab: AuxiliaryTab) {
			set({ activeAuxiliaryTab: tab });
		},

		async sendMessage(sessionId: string) {
			const draft = get().draftsBySessionId[sessionId]?.trim();
			if (!draft) {
				return;
			}

			const userMessage: ChatMessage = {
				id: `user-${Date.now()}`,
				sessionId,
				turnId: `user-turn-${Date.now()}`,
				role: 'user',
				content: draft,
				createdAt: new Date().toISOString()
			};

			set(state => ({
				messagesBySessionId: {
					...state.messagesBySessionId,
					[sessionId]: [...(state.messagesBySessionId[sessionId] ?? []), userMessage]
				},
				draftsBySessionId: { ...state.draftsBySessionId, [sessionId]: '' }
			}));

			for await (const event of get().provider.sendMessage(sessionId, { text: draft })) {
				get().applyEvent(event);
			}
		},

		async cancelTurn(sessionId: string) {
			const inFlightTurnId = get().inFlightTurnsBySessionId[sessionId];
			if (!inFlightTurnId) {
				return;
			}

			const now = new Date().toISOString();
			set(state => {
				const session = state.sessionsById[sessionId];
				const messages = state.messagesBySessionId[sessionId] ?? [];
				const toolCalls = state.toolCallsBySessionId[sessionId] ?? [];
				const settledToolCalls: ToolCall[] = toolCalls.map(toolCall =>
					toolCall.turnId !== inFlightTurnId || toolCall.status !== 'pending'
						? toolCall
						: { ...toolCall, status: 'failed' as const }
				);

				return {
					messagesBySessionId: {
						...state.messagesBySessionId,
						[sessionId]: messages.map(message =>
							message.turnId === inFlightTurnId ? { ...message, streaming: false } : message
						)
					},
					toolCallsBySessionId: {
						...state.toolCallsBySessionId,
						[sessionId]: settledToolCalls
					},
					inFlightTurnsBySessionId: omitKey(state.inFlightTurnsBySessionId, sessionId),
					sessionsById: session
						? { ...state.sessionsById, [sessionId]: { ...session, status: 'idle', updatedAt: now } }
						: state.sessionsById
				};
			});

			await get().provider.cancelTurn(sessionId, inFlightTurnId);
		},

		applyEvent(event: AgentEvent) {
			if (event.type === 'message.created') {
				set(state => ({
					messagesBySessionId: {
						...state.messagesBySessionId,
						[event.sessionId]: [...(state.messagesBySessionId[event.sessionId] ?? []), event.message]
					},
					inFlightTurnsBySessionId: { ...state.inFlightTurnsBySessionId, [event.sessionId]: event.turnId }
				}));
				return;
			}

			if (event.type === 'message.delta') {
				set(state => ({
					messagesBySessionId: {
						...state.messagesBySessionId,
						[event.sessionId]: (state.messagesBySessionId[event.sessionId] ?? []).map(message =>
							message.id === event.messageId ? { ...message, content: message.content + event.delta } : message
						)
					}
				}));
				return;
			}

			if (event.type === 'message.completed') {
				set(state => ({
					messagesBySessionId: {
						...state.messagesBySessionId,
						[event.sessionId]: (state.messagesBySessionId[event.sessionId] ?? []).map(message =>
							message.id === event.messageId ? { ...message, streaming: false } : message
						)
					},
					inFlightTurnsBySessionId: omitKey(state.inFlightTurnsBySessionId, event.sessionId)
				}));
				return;
			}

			if (event.type === 'tool.pending') {
				set(state => ({
					toolCallsBySessionId: {
						...state.toolCallsBySessionId,
						[event.sessionId]: [...(state.toolCallsBySessionId[event.sessionId] ?? []), event.toolCall]
					}
				}));
				return;
			}

			if (event.type === 'tool.completed') {
				set(state => ({
					toolCallsBySessionId: {
						...state.toolCallsBySessionId,
						[event.sessionId]: (state.toolCallsBySessionId[event.sessionId] ?? []).map(toolCall =>
							toolCall.id === event.toolCallId ? { ...toolCall, status: 'completed' } : toolCall
						)
					}
				}));
				return;
			}

			if (event.type === 'session.updated') {
				set(state => ({
					sessionsById: { ...state.sessionsById, [event.session.id]: event.session }
				}));
			}
		}
	}));
}

function cloneRecord<T>(record: Record<string, T[]>): Record<string, T[]> {
	return Object.fromEntries(Object.entries(record).map(([key, values]) => [key, values.map(value => ({ ...value }))]));
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
	const next = { ...record };
	delete next[key];
	return next;
}

export const useAgentStore = createAgentStore(createMockAgentProvider());

export function resetAgentStoreForTests() {
	useAgentStore.setState({
		provider: createMockAgentProvider({ chunkDelayMs: 0 }),
		initialized: false,
		sessionsById: {},
		sessionOrder: [],
		activeSessionId: null,
		messagesBySessionId: {},
		toolCallsBySessionId: {},
		fileChangesBySessionId: {},
		filesBySessionId: {},
		draftsBySessionId: {},
		activeAuxiliaryTab: 'changes',
		inFlightTurnsBySessionId: {}
	});
}
