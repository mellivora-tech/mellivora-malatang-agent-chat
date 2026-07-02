import { render, screen } from '@testing-library/react';
import { App } from '../App';

test('renders the desktop app shell', () => {
	render(<App />);

	expect(screen.getByRole('main', { name: 'Agent Chat Desktop' })).toBeInTheDocument();
	expect(screen.getByText('Agent Chat')).toBeInTheDocument();
});
