import { useEffect } from 'react';
import { AuxiliaryPanel } from '../auxiliary/AuxiliaryPanel';
import { ChatSurface } from '../chat/ChatSurface';
import { SessionsSidebar } from '../sidebar/SessionsSidebar';
import { useAgentStore } from '../../store/useAgentStore';

export function AppShell() {
	const initialize = useAgentStore(state => state.initialize);
	const initialized = useAgentStore(state => state.initialized);
	const activeSessionId = useAgentStore(state => state.activeSessionId);
	const activeSession = useAgentStore(state => (activeSessionId ? state.sessionsById[activeSessionId] : undefined));

	useEffect(() => {
		if (!initialized) {
			void initialize();
		}
	}, [initialize, initialized]);

	return (
		<div className="app-shell">
			<header className="titlebar">
				<span>Agent Chat</span>
				<span>{activeSession?.workspaceLabel ?? 'No Workspace'}</span>
			</header>
			<div className="workspace">
				<SessionsSidebar />
				<ChatSurface />
				<AuxiliaryPanel />
			</div>
		</div>
	);
}
