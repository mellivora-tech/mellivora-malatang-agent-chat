import type { ChatMessage, ToolCall } from '../../domain/types';

interface TranscriptProps {
	messages: ChatMessage[];
	toolCalls: ToolCall[];
}

export function Transcript({ messages, toolCalls }: TranscriptProps) {
	return (
		<section className="transcript" aria-label="Transcript">
			{messages.length === 0 && toolCalls.length === 0 ? (
				<div className="chat-empty">No messages yet.</div>
			) : (
				<>
					{messages.map(message => (
						<article key={message.id} className={`message ${message.role}${message.failed ? ' failed' : ''}`}>
							<div className="message-role">{message.role}</div>
							<div className="message-content">{message.content}</div>
							{message.failed ? <button type="button" disabled>Retry Turn</button> : null}
							{message.streaming ? <div className="message-streaming">Streaming</div> : null}
						</article>
					))}
					{toolCalls.map(toolCall => (
						<div key={toolCall.id} className={`tool-call ${toolCall.status}`}>
							<strong>{toolCall.title}</strong>
							<span>{toolCall.description}</span>
							<em>{toolCall.status}</em>
						</div>
					))}
				</>
			)}
		</section>
	);
}
