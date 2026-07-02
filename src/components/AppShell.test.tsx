import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { resetAgentStoreForTests } from '../store/useAgentStore';

beforeEach(() => {
	resetAgentStoreForTests();
});

test('renders the VS Code-inspired agent shell', async () => {
	render(<App />);

	expect(await screen.findByRole('navigation', { name: 'Sessions' })).toBeInTheDocument();
	expect(screen.getByRole('main', { name: 'Chat' })).toBeInTheDocument();
	expect(screen.getByRole('complementary', { name: 'Auxiliary Panel' })).toBeInTheDocument();
	expect(screen.getByRole('button', { name: 'New Session' })).toBeInTheDocument();
	expect(within(screen.getByRole('navigation', { name: 'Sessions' })).getByText('Refactor Auth Flow')).toBeInTheDocument();
});

test('creates and selects a new session from the sidebar', async () => {
	const user = userEvent.setup();
	render(<App />);

	await user.click(await screen.findByRole('button', { name: 'New Session' }));

	await waitFor(() => expect(screen.getByRole('heading', { name: 'New Session 4' })).toBeInTheDocument());
	expect(screen.getByRole('heading', { name: 'New Session 4' })).toBeInTheDocument();
});

test('switches auxiliary tabs', async () => {
	const user = userEvent.setup();
	render(<App />);

	await screen.findByRole('heading', { name: 'Refactor Auth Flow' });
	await user.click(screen.getByRole('tab', { name: 'Files' }));

	expect(screen.getByText('src/auth/redirect.ts')).toBeInTheDocument();
});
