import { Plus } from 'lucide-react';
import { useAgentStore } from '../../store/useAgentStore';

export function SessionsSidebar() {
	const sessionOrder = useAgentStore(state => state.sessionOrder);
	const sessionsById = useAgentStore(state => state.sessionsById);
	const activeSessionId = useAgentStore(state => state.activeSessionId);
	const createSession = useAgentStore(state => state.createSession);
	const selectSession = useAgentStore(state => state.selectSession);

	return (
		<nav aria-label="Sessions" className="sessions-sidebar">
			<div className="panel-header">
				<span>Sessions</span>
				<button className="sidebar-action" type="button" onClick={() => void createSession()}>
					<Plus size={14} aria-hidden="true" />
					<span>New Session</span>
				</button>
			</div>
			<div className="session-list">
				{sessionOrder.map(sessionId => {
					const session = sessionsById[sessionId];
					const isActive = sessionId === activeSessionId;

					return (
						<button
							key={session.id}
							aria-current={isActive ? 'page' : undefined}
							className={isActive ? 'session-row active' : 'session-row'}
							type="button"
							onClick={() => selectSession(session.id)}
						>
							<div>
								<div className="session-title">{session.title}</div>
								<div className="session-meta">{session.workspaceLabel}</div>
							</div>
							<div className="session-status">{session.status}</div>
						</button>
					);
				})}
			</div>
		</nav>
	);
}
