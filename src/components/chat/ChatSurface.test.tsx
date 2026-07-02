import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../App';
import { createMockAgentProvider } from '../../domain/mockProvider';
import { resetAgentStoreForTests, useAgentStore } from '../../store/useAgentStore';

beforeEach(() => {
	resetAgentStoreForTests();
});

test('sends a user message and renders a streamed mock assistant response', async () => {
	const user = userEvent.setup();
	render(<App />);

	const composer = await screen.findByRole('textbox', { name: 'Message' });
	await user.type(composer, 'summarize the changes');
	await user.click(screen.getByRole('button', { name: 'Send Message' }));

	expect(await screen.findByText('summarize the changes')).toBeInTheDocument();
	await waitFor(() => {
		expect(screen.getByText(/The safest first change is to isolate the UI state/)).toBeInTheDocument();
	});
	expect(screen.getByText('Inspect Mock Workspace')).toBeInTheDocument();
});

test('cancels an active turn and settles streaming UI state', async () => {
	const user = userEvent.setup();
	useAgentStore.setState({
		provider: createMockAgentProvider({ chunkDelayMs: 50 })
	});

	render(<App />);

	const composer = await screen.findByRole('textbox', { name: 'Message' });
	await user.type(composer, 'cancel this turn');
	await user.click(screen.getByRole('button', { name: 'Send Message' }));

	const cancelButton = screen.getByRole('button', { name: 'Cancel Turn' });
	await waitFor(() => expect(cancelButton).toBeEnabled());

	await user.click(cancelButton);

	await waitFor(() => {
		expect(screen.queryByText('Streaming')).not.toBeInTheDocument();
		expect(within(screen.getByRole('main', { name: 'Chat' })).queryByText('running')).not.toBeInTheDocument();
	});
});
