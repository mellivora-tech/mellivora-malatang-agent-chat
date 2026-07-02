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

test('links auxiliary tabs and tabpanel with accessible relations', async () => {
	render(<App />);

	await screen.findByRole('tab', { name: 'Changes' });
	const changesTab = screen.getByRole('tab', { name: 'Changes' });
	const filesTab = screen.getByRole('tab', { name: 'Files' });
	const detailsTab = screen.getByRole('tab', { name: 'Details' });
	const tabPanel = screen.getByRole('tabpanel');

	expect(changesTab).toHaveAttribute('aria-controls', 'aux-tabpanel-changes');
	expect(filesTab).toHaveAttribute('aria-controls', 'aux-tabpanel-files');
	expect(detailsTab).toHaveAttribute('aria-controls', 'aux-tabpanel-details');
	expect(tabPanel.id).toBe(changesTab.getAttribute('aria-controls'));
	expect(tabPanel).toHaveAttribute('aria-labelledby', changesTab.id);
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
	const changesTab = screen.getByRole('tab', { name: 'Changes' });
	const filesTab = screen.getByRole('tab', { name: 'Files' });
	const detailsTab = screen.getByRole('tab', { name: 'Details' });

	await user.click(changesTab);
	await user.keyboard('{ArrowRight}');
	expect(filesTab).toHaveAttribute('aria-selected', 'true');
	expect(screen.getByText('src/auth/redirect.ts')).toBeInTheDocument();
	await user.keyboard('{End}');
	expect(detailsTab).toHaveAttribute('aria-selected', 'true');
	expect(within(screen.getByRole('tabpanel')).getByText('Mock Agent')).toBeInTheDocument();
});

test('moves focus when using keyboard tab navigation', async () => {
	const user = userEvent.setup();
	render(<App />);

	await screen.findByRole('heading', { name: 'Refactor Auth Flow' });
	const changesTab = screen.getByRole('tab', { name: 'Changes' });
	const filesTab = screen.getByRole('tab', { name: 'Files' });
	const detailsTab = screen.getByRole('tab', { name: 'Details' });

	await user.click(changesTab);
	await user.keyboard('{Home}');
	expect(changesTab).toHaveAttribute('aria-selected', 'true');
	await user.keyboard('{ArrowRight}');
	expect(filesTab).toHaveFocus();
	await user.keyboard('{End}');
	expect(detailsTab).toHaveFocus();
});
