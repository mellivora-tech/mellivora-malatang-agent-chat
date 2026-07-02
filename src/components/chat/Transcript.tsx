import { useEffect, useRef } from 'react';
import type { ChatMessage, ToolCall } from '../../domain/types';

interface TranscriptProps {
	messages: ChatMessage[];
	toolCalls: ToolCall[];
}

export function Transcript({ messages, toolCalls }: TranscriptProps) {
	const endRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (messages.length === 0 && toolCalls.length === 0) {
			return;
		}

		if (typeof endRef.current?.scrollIntoView === 'function') {
			endRef.current.scrollIntoView({ block: 'end' });
		}
	}, [messages, toolCalls]);

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
					<div ref={endRef} aria-hidden="true" />
				</>
			)}
		</section>
	);
}
