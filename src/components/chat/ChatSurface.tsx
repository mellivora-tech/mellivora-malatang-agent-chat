import { Composer } from './Composer';
import { Transcript } from './Transcript';
import { useAgentStore } from '../../store/useAgentStore';

export function ChatSurface() {
	const activeSessionId = useAgentStore(state => state.activeSessionId);
	const session = useAgentStore(state => (activeSessionId ? state.sessionsById[activeSessionId] : undefined));
	const messages = useAgentStore(state => (activeSessionId ? state.messagesBySessionId[activeSessionId] ?? [] : []));
	const toolCalls = useAgentStore(state => (activeSessionId ? state.toolCallsBySessionId[activeSessionId] ?? [] : []));

	if (!activeSessionId || !session) {
		return <main aria-label="Chat" className="chat-surface" />;
	}

	return (
		<main aria-label="Chat" className="chat-surface">
			<header className="chat-header">
				<div>
					<h1>{session.title}</h1>
					<p>
						{session.providerName} · {session.workspaceLabel}
					</p>
				</div>
				<span className={`status-pill ${session.status}`}>{session.status}</span>
			</header>
			<Transcript messages={messages} toolCalls={toolCalls} />
			<Composer sessionId={activeSessionId} />
		</main>
	);
}
