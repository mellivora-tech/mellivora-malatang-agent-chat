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

test('sends with Ctrl Enter from the composer', async () => {
	const user = userEvent.setup();
	render(<App />);

	const composer = await screen.findByRole('textbox', { name: 'Message' });
	await user.type(composer, 'keyboard send');
	await user.keyboard('{Control>}{Enter}{/Control}');

	expect(await screen.findByText('keyboard send')).toBeInTheDocument();
});

test('sends with Meta Enter from the composer', async () => {
	const user = userEvent.setup();
	render(<App />);

	const composer = await screen.findByRole('textbox', { name: 'Message' });
	await user.type(composer, 'mac keyboard send');
	await user.keyboard('{Meta>}{Enter}{/Meta}');

	expect(await screen.findByText('mac keyboard send')).toBeInTheDocument();
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
		expect(screen.getByText('failed')).toBeInTheDocument();
		expect(screen.queryByText('pending')).not.toBeInTheDocument();
	});
});

test('renders an empty transcript for a new session', async () => {
	const user = userEvent.setup();
	render(<App />);

	await user.click(await screen.findByRole('button', { name: 'New Session' }));

	expect(await screen.findByText('No messages yet.')).toBeInTheDocument();
});

test('renders deterministic mock provider failure state', async () => {
	const user = userEvent.setup();
	render(<App />);

	const composer = await screen.findByRole('textbox', { name: 'Message' });
	await user.type(composer, '/fail');
	await user.click(screen.getByRole('button', { name: 'Send Message' }));

	expect(await screen.findByText('The mock provider failed this turn on request.')).toBeInTheDocument();
	expect(screen.getByRole('button', { name: 'Retry Turn' })).toBeDisabled();
	expect(within(screen.getByRole('main', { name: 'Chat' })).getByText('failed', { selector: '.status-pill' })).toBeInTheDocument();
});
