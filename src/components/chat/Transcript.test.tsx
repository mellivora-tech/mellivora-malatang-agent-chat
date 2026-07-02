import { render } from '@testing-library/react';
import { Transcript } from './Transcript';

test('scrolls the latest transcript content into view when messages change', () => {
	const scrollIntoView = vi.fn();
	Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
		configurable: true,
		value: scrollIntoView
	});

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
