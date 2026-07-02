import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../App';
import { resetAgentStoreForTests } from '../../store/useAgentStore';

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
