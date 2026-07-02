import { Send, Square } from 'lucide-react';
import { useAgentStore } from '../../store/useAgentStore';

interface ComposerProps {
	sessionId: string;
}

export function Composer({ sessionId }: ComposerProps) {
	const draft = useAgentStore(state => state.draftsBySessionId[sessionId] ?? '');
	const inFlightTurnId = useAgentStore(state => state.inFlightTurnsBySessionId[sessionId]);
	const setDraft = useAgentStore(state => state.setDraft);
	const sendMessage = useAgentStore(state => state.sendMessage);
	const provider = useAgentStore(state => state.provider);

	return (
		<form
			className="composer"
			onSubmit={event => {
				event.preventDefault();
				void sendMessage(sessionId);
			}}
		>
			<textarea
				aria-label="Message"
				value={draft}
				onChange={event => setDraft(sessionId, event.currentTarget.value)}
			/>
			<div className="composer-actions">
				<button className="icon-button" type="submit" aria-label="Send Message" disabled={!draft.trim() || Boolean(inFlightTurnId)}>
					<Send size={16} aria-hidden="true" />
				</button>
				<button
					className="icon-button"
					type="button"
					aria-label="Cancel Turn"
					disabled={!inFlightTurnId}
					onClick={() => {
						if (inFlightTurnId) {
							useAgentStore.setState(state => {
								const nextInFlightTurnsBySessionId = { ...state.inFlightTurnsBySessionId };
								delete nextInFlightTurnsBySessionId[sessionId];

								return { inFlightTurnsBySessionId: nextInFlightTurnsBySessionId };
							});
							void provider.cancelTurn(sessionId, inFlightTurnId);
						}
					}}
				>
					<Square size={16} aria-hidden="true" />
				</button>
			</div>
		</form>
	);
}
