import type { AgentSession, ChatMessage, FileChange, SessionFile } from './types';

export const seedSessions: AgentSession[] = [
	{
		id: 'session-auth',
		title: 'Refactor Auth Flow',
		providerName: 'Mock Agent',
		status: 'completed',
		workspaceLabel: 'mellivora-malatang',
		updatedAt: '2026-07-02T10:15:00.000Z',
		pinned: true,
		unread: false,
		archived: false
	},
	{
		id: 'session-build',
		title: 'Investigate Build Failure',
		providerName: 'Mock Agent',
		status: 'running',
		workspaceLabel: 'desktop-client',
		updatedAt: '2026-07-02T09:48:00.000Z',
		pinned: false,
		unread: true,
		archived: false
	},
	{
		id: 'session-release',
		title: 'Draft Release Notes',
		providerName: 'Mock Agent',
		status: 'idle',
		workspaceLabel: 'release-notes',
		updatedAt: '2026-07-01T18:22:00.000Z',
		pinned: false,
		unread: false,
		archived: false
	}
];

export const seedMessagesBySessionId: Record<string, ChatMessage[]> = {
	'session-auth': [
		{
			id: 'msg-auth-1',
			sessionId: 'session-auth',
			turnId: 'turn-auth-1',
			role: 'user',
			content: 'Can you simplify the auth redirect flow?',
			createdAt: '2026-07-02T10:12:00.000Z'
		},
		{
			id: 'msg-auth-2',
			sessionId: 'session-auth',
			turnId: 'turn-auth-1',
			role: 'assistant',
			content: 'I found three redirect branches that can share one guard and one callback path.',
			createdAt: '2026-07-02T10:12:08.000Z'
		}
	],
	'session-build': [],
	'session-release': []
};

export const seedFileChangesBySessionId: Record<string, FileChange[]> = {
	'session-auth': [
		{ id: 'change-auth-1', sessionId: 'session-auth', path: 'src/auth/redirect.ts', status: 'modified', additions: 42, deletions: 18 },
		{ id: 'change-auth-2', sessionId: 'session-auth', path: 'src/auth/session.ts', status: 'modified', additions: 16, deletions: 9 }
	],
	'session-build': [
		{ id: 'change-build-1', sessionId: 'session-build', path: 'vite.config.ts', status: 'modified', additions: 8, deletions: 2 }
	],
	'session-release': [
		{ id: 'change-release-1', sessionId: 'session-release', path: 'CHANGELOG.md', status: 'added', additions: 64, deletions: 0 }
	]
};

export const seedFilesBySessionId: Record<string, SessionFile[]> = {
	'session-auth': [
		{ id: 'file-auth-1', sessionId: 'session-auth', path: 'src', type: 'folder', depth: 0 },
		{ id: 'file-auth-2', sessionId: 'session-auth', path: 'src/auth', type: 'folder', depth: 1 },
		{ id: 'file-auth-3', sessionId: 'session-auth', path: 'src/auth/redirect.ts', type: 'file', depth: 2 }
	],
	'session-build': [
		{ id: 'file-build-1', sessionId: 'session-build', path: 'vite.config.ts', type: 'file', depth: 0 }
	],
	'session-release': [
		{ id: 'file-release-1', sessionId: 'session-release', path: 'CHANGELOG.md', type: 'file', depth: 0 }
	]
};
