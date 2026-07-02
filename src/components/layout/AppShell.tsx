import { Bot, Plus } from 'lucide-react';
import { FormEvent } from 'react';
import { AuxiliaryPanel } from '../auxiliary/AuxiliaryPanel';
import { SessionsSidebar } from '../sidebar/SessionsSidebar';
import { useAgentStore } from '../../store/useAgentStore';

export function AppShell() {
	const initialized = useAgentStore(state => state.initialized);
	const activeSessionId = useAgentStore(state => state.activeSessionId);
	const activeSession = useAgentStore(state => (state.activeSessionId ? state.sessionsById[state.activeSessionId] : null));
	const draft = useAgentStore(state => (state.activeSessionId ? state.draftsBySessionId[state.activeSessionId] ?? '' : ''));
	const messages = useAgentStore(state => (state.activeSessionId ? state.messagesBySessionId[state.activeSessionId] ?? [] : []));
	const setDraft = useAgentStore(state => state.setDraft);
	const sendMessage = useAgentStore(state => state.sendMessage);

	if (!initialized) {
		return (
			<div className="loading-shell" role="status" aria-label="Loading Agent Chat">
				Loading Agent Chat...
			</div>
		);
	}

	const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!activeSessionId) {
			return;
		}

		void sendMessage(activeSessionId);
	};

	return (
		<div className="app-shell">
			<header className="titlebar">
				<div className="titlebar__title">Agent Chat</div>
				<div className="panel-note">Mock agent desktop</div>
			</header>
			<div className="workspace">
				<SessionsSidebar />
				<main aria-label="Chat" className="chat-panel">
					<div className="chat-header">
						<div>
							<h1 className="session-title">{activeSession?.title ?? 'No Session Selected'}</h1>
							<div className="session-meta">
								{activeSession ? `${activeSession.providerName} • ${activeSession.workspaceLabel}` : 'Select a session to begin.'}
							</div>
						</div>
						<div className="panel-note">
							<Bot size={14} aria-hidden="true" />
							<span>{activeSession?.status ?? 'idle'}</span>
						</div>
					</div>
					<div className="chat-body">
						{activeSession ? (
							messages.length > 0 ? (
								<div className="chat-thread" aria-label="Messages">
									{messages.map(message => (
										<article key={message.id} className={`message ${message.role}`}>
											<div className="message-role">{message.role}</div>
											<div>{message.content}</div>
											<div className="message-time">{new Date(message.createdAt).toLocaleString()}</div>
										</article>
									))}
								</div>
							) : (
								<div className="chat-empty">No messages yet.</div>
							)
						) : (
							<div className="chat-empty">Choose a session from the sidebar.</div>
						)}
					</div>
					<div className="chat-footer">
						<form className="composer" onSubmit={handleSubmit}>
							<textarea
								aria-label="Message draft"
								disabled={!activeSession}
								placeholder="Type a message..."
								value={draft}
								onChange={event => activeSessionId && setDraft(activeSessionId, event.target.value)}
							/>
							<div className="composer-actions">
								<button className="primary-button" disabled={!activeSession || !draft.trim()} type="submit">
									<Plus size={14} aria-hidden="true" />
									<span>Send</span>
								</button>
							</div>
						</form>
					</div>
				</main>
				<AuxiliaryPanel />
			</div>
		</div>
	);
}
