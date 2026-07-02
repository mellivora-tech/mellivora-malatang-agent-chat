import { render } from '@testing-library/react';
import type { ChatMessage } from '../../domain/types';
import { Transcript } from './Transcript';

function mockScrollIntoView() {
	const scrollIntoView = vi.fn();
	Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
		configurable: true,
		value: scrollIntoView
	});

	return scrollIntoView;
}

test('scrolls the latest transcript content into view when messages change', () => {
	const scrollIntoView = mockScrollIntoView();
	const { rerender } = render(
		<Transcript
			messages={[]}
			toolCalls={[]}
		/>
	);

	expect(scrollIntoView).not.toHaveBeenCalled();

	rerender(
		<Transcript
			messages={[
				{
					id: 'msg-1',
					sessionId: 'session-1',
					turnId: 'turn-1',
					role: 'assistant',
					content: 'First streamed message',
					createdAt: '2026-07-02T00:00:00.000Z'
				}
			]}
			toolCalls={[]}
		/>
	);

	expect(scrollIntoView).toHaveBeenCalledTimes(1);
});

test('scrolls the latest transcript content into view when tool calls change', () => {
	const scrollIntoView = mockScrollIntoView();
	const messages: ChatMessage[] = [];
	const { rerender } = render(
		<Transcript
			messages={messages}
			toolCalls={[]}
		/>
	);

	expect(scrollIntoView).not.toHaveBeenCalled();

	rerender(
		<Transcript
			messages={messages}
			toolCalls={[
				{
					id: 'tool-1',
					sessionId: 'session-1',
					turnId: 'turn-1',
					title: 'Inspect Mock Workspace',
					description: 'Read mock context',
					status: 'pending'
				}
			]}
		/>
	);

	expect(scrollIntoView).toHaveBeenCalledTimes(1);
});
